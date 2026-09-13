import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PresetSchema, type Preset } from './schema/agents.js';

// Resolves to src/ under tsx/vitest and dist/ after build (copy-assets mirrors
// prompts + adapters/presets into dist). All packaged data is reached from here.
const base = dirname(fileURLToPath(import.meta.url));

export function readPrompt(name: 'generator' | 'evaluator'): string {
  return readFileSync(join(base, 'prompts', `${name}.md`), 'utf8');
}

const PLANNER_RULES_RE =
  /<!--\s*PLANNER_RULES_START\s*-->([\s\S]*?)<!--\s*PLANNER_RULES_END\s*-->/;

function modelRoutingCandidates(): string[] {
  return [
    join(base, 'docs', 'MODEL-ROUTING.md'),
    join(base, '..', 'docs', 'MODEL-ROUTING.md'),
  ];
}

/** Full model-routing doc (human + machine). */
export function readModelRoutingGuide(): string {
  for (const path of modelRoutingCandidates()) {
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  throw new Error('MODEL-ROUTING.md not found (expected docs/MODEL-ROUTING.md)');
}

/** Planner-only rules block injected into orchestrator prompts. */
export function readPlannerRoutingRules(): string {
  const full = readModelRoutingGuide();
  const match = full.match(PLANNER_RULES_RE);
  if (match?.[1]?.trim()) return match[1].trim();
  return full;
}

export function presetsDir(): string {
  return join(base, 'adapters', 'presets');
}

export function loadPreset(name: string): Preset {
  const path = join(presetsDir(), `${name}.yaml`);
  const raw = parseYaml(readFileSync(path, 'utf8'));
  return PresetSchema.parse(raw);
}

/** Names of all packaged presets (filenames without .yaml). */
export function listPresetNames(): string[] {
  return readdirSync(presetsDir())
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => basename(f, '.yaml'))
    .filter((name) => name !== 'hermes')
    .sort();
}
