import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildJsonSchemas } from '../src/schema/specs.js';

const here = dirname(fileURLToPath(import.meta.url));
const specsDir = join(here, '..', 'src', 'specs');
mkdirSync(specsDir, { recursive: true });

const schemas = buildJsonSchemas();
for (const [name, schema] of Object.entries(schemas)) {
  const file = join(specsDir, `${name}.schema.json`);
  writeFileSync(file, JSON.stringify(schema, null, 2) + '\n');
  process.stdout.write(`wrote ${file}\n`);
}
