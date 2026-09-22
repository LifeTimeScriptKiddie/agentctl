import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildMemoryPlaneExport,
  datedExportPath,
  datedReportDir,
  parseSinceToMs,
  writeMemoryPlaneExport,
} from './memoryUsageExport.js';
import {
  analyzeMemoryPlaneExport,
  resolveSessiongraphRoot,
  suggestMemoryArchitecture,
} from './sessiongraphBridge.js';

export interface NightlyOptions {
  since?: string;
  exportPath?: string;
  reportDir?: string;
  dryRun?: boolean;
  skipSuggest?: boolean;
}

export interface NightlyResult {
  ok: boolean;
  sessiongraph_root: string | null;
  export_path: string;
  analysis_dir: string;
  suggest_dir?: string;
  dry_run: boolean;
  errors: string[];
}

export async function runMemorySessiongraphNightly(opts: NightlyOptions = {}): Promise<NightlyResult> {
  const sinceMs = parseSinceToMs(opts.since ?? '24h');
  const exportPath = opts.exportPath ?? datedExportPath();
  const analysisDir = opts.reportDir ?? datedReportDir();
  const suggestDir = join(analysisDir, 'suggest-agentctl');
  const root = resolveSessiongraphRoot();
  const errors: string[] = [];

  if (opts.dryRun) {
    return {
      ok: Boolean(root),
      sessiongraph_root: root,
      export_path: exportPath,
      analysis_dir: analysisDir,
      suggest_dir: opts.skipSuggest ? undefined : suggestDir,
      dry_run: true,
      errors: root ? [] : ['AGENTCTL_SESSIONGRAPH_ROOT is not set'],
    };
  }

  if (!root) {
    return {
      ok: false,
      sessiongraph_root: null,
      export_path: exportPath,
      analysis_dir: analysisDir,
      dry_run: false,
      errors: ['Set AGENTCTL_SESSIONGRAPH_ROOT to a sessiongraph git checkout'],
    };
  }

  mkdirSync(join(exportPath, '..'), { recursive: true, mode: 0o700 });
  mkdirSync(analysisDir, { recursive: true, mode: 0o700 });

  const payload = await buildMemoryPlaneExport(sinceMs);
  writeMemoryPlaneExport(payload, exportPath);

  const analyze = await analyzeMemoryPlaneExport(exportPath, analysisDir);
  if (analyze.exitCode !== 0) {
    errors.push(analyze.stderr.trim() || `sessiongraph analyze-memory-plane exited ${analyze.exitCode}`);
  }

  let suggestOk = true;
  if (!opts.skipSuggest && analyze.exitCode === 0) {
    mkdirSync(suggestDir, { recursive: true, mode: 0o700 });
    const analysisJson = join(analysisDir, 'analysis.json');
    const suggest = await suggestMemoryArchitecture(analysisJson, suggestDir);
    if (suggest.exitCode !== 0) {
      suggestOk = false;
      errors.push(suggest.stderr.trim() || `sessiongraph suggest-workflow exited ${suggest.exitCode}`);
    }
  }

  return {
    ok: analyze.exitCode === 0 && suggestOk && errors.length === 0,
    sessiongraph_root: root,
    export_path: exportPath,
    analysis_dir: analysisDir,
    suggest_dir: opts.skipSuggest ? undefined : suggestDir,
    dry_run: false,
    errors,
  };
}
