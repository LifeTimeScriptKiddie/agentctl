/**
 * Team memory lives in its own repo (github.com/LifeTimeScriptKiddie/shared_ptr).
 * agentctl reaches it only over HTTP or by running its CLI, and shares code with
 * it only through published packages (agentctl-kit, shared-ptr-contract).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const root = join(import.meta.dirname, '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'dist' || name === 'node_modules' ? [] : tsFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

function imports(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

describe('shared_ptr boundary', () => {
  it('agentctl never imports the shared_ptr server package', () => {
    const bad = tsFiles(join(root, 'src')).flatMap((f) => imports(f)
      .filter((i) => i === '@lifetimescriptkiddie/shared-ptr' || i.startsWith('@lifetimescriptkiddie/shared-ptr/'))
      .map((i) => `${relative(root, f)} → ${i}`));
    expect(bad).toEqual([]);
  });

  it('kit imports nothing outside itself', () => {
    const kit = join(root, 'packages', 'kit');
    const bad = tsFiles(join(kit, 'src')).flatMap((f) => imports(f)
      .filter((i) => i.startsWith('.'))
      .map((i) => resolve(dirname(f), i))
      .filter((p) => !inside(p, kit))
      .map((p) => `${relative(root, f)} → ${relative(root, p)}`));
    expect(bad).toEqual([]);
  });
});
