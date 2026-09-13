import { cpSync, existsSync, rmSync } from 'node:fs';

// Mirror packaged data into dist/ so the compiled CLI can read presets,
// prompts, and exported JSON schemas. tsc only emits .js/.d.ts.
const copies = [
  ['src/prompts', 'dist/prompts'],
  ['src/adapters/presets', 'dist/adapters/presets'],
  ['src/specs', 'dist/specs'],
  ['docs', 'dist/docs'],
];

for (const [from, to] of copies) {
  if (!existsSync(from)) {
    console.warn(`copy-assets: skipping missing ${from}`);
    continue;
  }
  // clear the target first so renamed/removed assets don't linger in dist/
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  console.log(`copy-assets: ${from} -> ${to}`);
}
