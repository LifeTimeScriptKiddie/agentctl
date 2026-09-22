import { cpSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Mirror packaged data into dist/ so the compiled CLI can read presets,
// prompts, and exported JSON schemas. tsc only emits .js/.d.ts.
const copies = [
  ['src/prompts', 'dist/prompts'],
  ['src/adapters/presets', 'dist/adapters/presets'],
  ['src/specs', 'dist/specs'],
  ['docs', 'dist/docs'],
  ['scripts/laya_evidence.py', 'dist/scripts/laya_evidence.py'],
  ['src/memory/turn-graph.default.yaml', 'dist/memory/turn-graph.default.yaml'],
  ['src/memory/postgres/migrations', 'dist/memory/postgres/migrations'],
];

for (const [from, to] of copies) {
  if (from.includes('.') && !existsSync(from)) {
    console.warn(`copy-assets: skipping missing ${from}`);
    continue;
  }
  if (from.endsWith('.py')) {
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
    console.log(`copy-assets: ${from} -> ${to}`);
    continue;
  }
  // clear the target first so renamed/removed assets don't linger in dist/
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  console.log(`copy-assets: ${from} -> ${to}`);
}
