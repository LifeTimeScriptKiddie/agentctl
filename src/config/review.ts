import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml, parseDocument, visit, isPair, isScalar } from 'yaml';

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

/** Environment variables that make a launched program load or execute other code. */
const CODE_LOADING_ENV = new Set([
  'NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PYTHONPATH', 'PYTHONSTARTUP',
  'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS',
]);

export interface ReviewLine {
  text: string;
  highlight: boolean;
}

const SENSITIVE_KEYS = new Set(['commandTemplate', 'healthProbe', 'environment']);

/**
 * 0-based line numbers covered by a sensitive key and its value, found from the
 * parsed YAML so escaped or quoted spellings of the key (e.g. "health\x50robe")
 * are still flagged. Empty when the text does not parse.
 */
function parsedSensitiveLines(text: string): Set<number> {
  const lines = new Set<number>();
  let doc;
  try {
    doc = parseDocument(text);
  } catch {
    return lines;
  }
  const lineAt = (offset: number) => text.slice(0, offset).split('\n').length - 1;
  visit(doc, {
    Pair(_key, pair) {
      if (!isPair(pair) || !isScalar(pair.key) || !SENSITIVE_KEYS.has(String(pair.key.value))) return;
      const start = pair.key.range?.[0];
      const valueRange = (pair.value as { range?: [number, number, number] } | null)?.range;
      const end = valueRange?.[1] ?? pair.key.range?.[1];
      if (start === undefined || end === undefined) return;
      for (let l = lineAt(start); l <= lineAt(Math.max(start, end - 1)); l++) lines.add(l);
    },
  });
  return lines;
}

/** Lines of `text`, with commandTemplate/healthProbe/environment and their nested block values flagged. */
export function reviewLines(text: string): ReviewLine[] {
  let blockIndent: number | null = null;
  const parsed = parsedSensitiveLines(text);
  return text.split('\n').map((line, index) => {
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
    return { text: line, highlight: (blockIndent !== null && !blank) || parsed.has(index) };
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
        // Arguments with spaces are still checked; placeholders and URLs are not paths.
        if (typeof arg !== 'string' || /\{|:\/\//.test(arg) || arg.trim() === '') return;
        const pathLike = i === 0 ? arg.includes('/') : /^(\.{1,2}\/|\/|~\/)/.test(arg);
        let problem = pathLike ? pathProblem(arg, root) : null;
        // `--require=./x.js` style: check the value after '='.
        const eq = arg.startsWith('-') ? arg.indexOf('=') : -1;
        if (!problem && eq > 0) {
          const value = arg.slice(eq + 1);
          if (/^(\.{1,2}\/|\/|~\/)/.test(value)) problem = pathProblem(value, root);
          else if (value && existsSync(join(root, value))) {
            problem = `names a file inside the repository (${root}), where a worker could change it`;
          }
        }
        // A bare relative argument (e.g. `scripts/x.js`) that names a file in the
        // repo is a script the worker could change after trust.
        if (!problem && i > 0 && !pathLike && !arg.startsWith('-')
          && (existsSync(join(root, arg)) || existsSync(join(dirname(resolve(configPath)), arg)))) {
          problem = `names a file inside the repository (${root}), where a worker could change it`;
        }
        if (problem) warnings.push(`${name}.${field}[${i}] ${JSON.stringify(arg)} ${problem}`);
      });
    }
    const env = preset.environment;
    if (env && typeof env === 'object') {
      for (const key of Object.keys(env as Record<string, unknown>)) {
        if (CODE_LOADING_ENV.has(key) || key.startsWith('DYLD_')) {
          warnings.push(`${name}.environment.${key} makes the launched program load or run other code`);
        }
      }
    }
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
