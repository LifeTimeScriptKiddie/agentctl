import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * What `agentctl config trust` shows before the user approves a local
 * agents.yaml. The display must not be steerable by the file itself, and the
 * keys that choose executables must stand out.
 */

/** C0/C1 controls except tab and newline, plus bidi marks/overrides/isolates that reorder what a terminal shows. */
const DISPLAY_CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export function stripControlChars(text: string): { text: string; removed: number } {
  let removed = 0;
  const out = text.replace(DISPLAY_CONTROL_RE, () => {
    removed++;
    return '';
  });
  return { text: out, removed };
}

const SENSITIVE_KEY_RE = /\b(commandTemplate|healthProbe|environment)\b/;

export interface ReviewLine {
  text: string;
  highlight: boolean;
}

/** Lines of `text`, with commandTemplate/healthProbe/environment and their nested block values flagged. */
export function reviewLines(text: string): ReviewLine[] {
  let blockIndent: number | null = null;
  return text.split('\n').map((line) => {
    const indent = /^ */.exec(line)![0].length;
    const blank = line.trim() === '';
    if (blockIndent !== null && !blank) {
      const nested = indent > blockIndent || (indent === blockIndent && line.trimStart().startsWith('- '));
      if (!nested) blockIndent = null;
    }
    if (SENSITIVE_KEY_RE.test(line)) {
      blockIndent = indent;
      return { text: line, highlight: true };
    }
    return { text: line, highlight: blockIndent !== null && !blank };
  });
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Nearest ancestor with a `.git` entry, else the config's own directory. */
export function repoRootFor(configPath: string): string {
  const start = dirname(resolve(configPath));
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return start;
  }
}

function expandTilde(p: string): string {
  return p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p;
}

/** realpath of the nearest existing ancestor plus the rest, so symlinked prefixes compare equal. */
function realish(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(basename(head));
    head = dirname(head);
  }
  try {
    return join(realpathSync(head), ...tail);
  } catch {
    return resolve(path);
  }
}

function pathProblem(path: string, root: string): string | null {
  const expanded = expandTilde(path);
  if (!isAbsolute(expanded)) return 'is a relative path, resolved against the working directory at run time';
  if (isInside(realish(expanded), realish(root))) {
    return `points inside the repository (${root}), where a worker could change it`;
  }
  return null;
}

/**
 * Trust covers agents.yaml, not the programs it names. Flags argv entries that
 * are relative paths or inside the repo: argv[0] when it contains a `/`
 * (bare names are PATH lookups), other arguments when they start with `./`,
 * `../`, `/` or `~/`, and every entry of an `environment.PATH` override.
 */
export function executablePathWarnings(content: string, configPath: string): string[] {
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch {
    return [];
  }
  const agents = (doc as { agents?: unknown } | null)?.agents;
  if (!agents || typeof agents !== 'object') return [];
  const root = repoRootFor(configPath);
  const warnings: string[] = [];
  for (const [name, raw] of Object.entries(agents as Record<string, unknown>)) {
    const preset = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    for (const field of ['commandTemplate', 'healthProbe']) {
      const argv = preset[field];
      if (!Array.isArray(argv)) continue;
      argv.forEach((arg, i) => {
        if (typeof arg !== 'string' || /\s|\{|:\/\//.test(arg)) return;
        const pathLike = i === 0 ? arg.includes('/') : /^(\.{1,2}\/|\/|~\/)/.test(arg);
        const problem = pathLike ? pathProblem(arg, root) : null;
        if (problem) warnings.push(`${name}.${field}[${i}] ${JSON.stringify(arg)} ${problem}`);
      });
    }
    const env = preset.environment;
    const pathVar = env && typeof env === 'object' ? (env as Record<string, unknown>).PATH : undefined;
    if (typeof pathVar === 'string') {
      for (const entry of pathVar.split(':')) {
        const problem = pathProblem(entry || '.', root);
        if (problem) warnings.push(`${name}.environment.PATH entry ${JSON.stringify(entry)} ${problem}`);
      }
    }
  }
  return warnings;
}
