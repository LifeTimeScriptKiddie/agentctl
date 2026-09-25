/**
 * The shared_ptr split, enforced: agentctl (src/) never imports the shared_ptr
 * server package, and shared_ptr never imports agentctl's src/. Both may use
 * only @agentctl/kit and @shared_ptr/contract. (Tests may cross; they are the
 * integration layer.)
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
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

/** Relative imports of `file`, resolved to absolute paths. */
function resolvedImports(file: string): string[] {
  return imports(file).filter((i) => i.startsWith('.')).map((i) => resolve(dirname(file), i));
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);
const SHARED_PTR = join(root, 'packages', 'shared_ptr');

describe('shared_ptr boundary', () => {
  it('agentctl src/ never imports the shared_ptr server', () => {
    const bad = tsFiles(join(root, 'src')).flatMap((f) => [
      ...resolvedImports(f).filter((p) => inside(p, SHARED_PTR)),
      ...imports(f).filter((i) => i.startsWith('@shared_ptr/server')),
    ].map((i) => `${relative(root, f)} → ${relative(root, i)}`));
    expect(bad).toEqual([]);
  });

  it('shared_ptr never imports agentctl src/ (or anything outside its package)', () => {
    const bad = tsFiles(join(SHARED_PTR, 'src')).flatMap((f) => resolvedImports(f)
      .filter((p) => !inside(p, SHARED_PTR))
      .map((p) => `${relative(root, f)} → ${relative(root, p)}`));
    expect(bad).toEqual([]);
  });

  it('kit and contract import nothing outside themselves', () => {
    const bad = ['kit', 'contract'].flatMap((pkg) => {
      const dir = join(root, 'packages', pkg);
      return tsFiles(join(dir, 'src')).flatMap((f) => [
        ...resolvedImports(f).filter((p) => !inside(p, dir)),
        ...imports(f).filter((i) => i.startsWith('@shared_ptr/server')),
      ].map((i) => `${relative(root, f)} → ${i}`));
    });
    expect(bad).toEqual([]);
  });
});
