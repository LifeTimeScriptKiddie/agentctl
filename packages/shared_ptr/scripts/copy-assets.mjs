import { cpSync, rmSync } from 'node:fs';

// tsc emits only .js/.d.ts; the turn graph and SQL migrations ship beside them.
for (const [from, to] of [
  ['src/turn-graph.default.yaml', 'dist/turn-graph.default.yaml'],
  ['src/postgres/migrations', 'dist/postgres/migrations'],
]) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}
