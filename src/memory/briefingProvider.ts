/**
 * The one door from agentctl into team memory. agentctl never imports
 * shared_ptr: it reaches it over HTTP (a gatekeeper at AGENTCTL_GATEWAY_URL)
 * or by running the shared_ptr CLI, and with neither it simply briefs nothing.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ResumeBriefing } from '@shared_ptr/contract';
import { run } from '../util/exec.js';

export type ProviderKind = 'http' | 'exec' | 'none';

/** How to run the shared_ptr CLI: SHARED_PTR_BIN, the sibling workspace build, else `shared_ptr` on PATH. */
export function resolveSharedPtrCommand(): { file: string; args: string[]; via: string } | null {
  const explicit = process.env.SHARED_PTR_BIN?.trim();
  if (explicit) return explicit.endsWith('.js')
    ? { file: process.execPath, args: [explicit], via: 'SHARED_PTR_BIN' }
    : { file: explicit, args: [], via: 'SHARED_PTR_BIN' };
  // In this monorepo phase the server builds beside agentctl (dist/memory → ../../packages/…).
  const sibling = fileURLToPath(new URL('../../packages/shared_ptr/dist/cli.js', import.meta.url));
  if (existsSync(sibling)) return { file: process.execPath, args: [sibling], via: 'workspace' };
  return { file: 'shared_ptr', args: [], via: 'PATH' };
}

/** Local resume briefing from the shared_ptr CLI; null when it is not installed or fails. */
export async function execResumeBriefing(workspace: string, provider: string, maxBytes: number): Promise<ResumeBriefing | null> {
  const cmd = resolveSharedPtrCommand();
  if (!cmd) return null;
  const r = await run(cmd.file, [...cmd.args, 'briefing', '--workspace', workspace, '--provider', provider,
    '--max-bytes', String(maxBytes)], { timeoutMs: 30_000 }).catch(() => null);
  if (!r || r.exitCode !== 0) return null;
  try {
    const parsed = ResumeBriefing.safeParse(JSON.parse(r.stdout.trim()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type LocalBriefing = (workspace: string, provider: string, maxBytes: number) => Promise<ResumeBriefing | null>;

let localBriefing: LocalBriefing = execResumeBriefing;

/** Swap the no-gateway briefing source (tests, embedders that host shared_ptr in-process). */
export function setLocalBriefingSource(next: LocalBriefing | null): void {
  localBriefing = next ?? execResumeBriefing;
}

export function loadLocalBriefing(workspace: string, provider: string, maxBytes: number): Promise<ResumeBriefing | null> {
  return localBriefing(workspace, provider, maxBytes);
}
