import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (p: string) => fileURLToPath(new URL(`./packages/${p}`, import.meta.url));

export default defineConfig({
  // Tests run workspace packages from source, so no build step is needed first.
  resolve: {
    alias: [
      { find: /^@lifetimescriptkiddie\/agentctl-kit$/, replacement: pkg('kit/src/index.ts') },
      { find: /^@lifetimescriptkiddie\/agentctl-kit\/(.*)$/, replacement: pkg('kit/src/$1.ts') },
      { find: /^@lifetimescriptkiddie\/shared-ptr-contract$/, replacement: pkg('contract/src/index.ts') },
      { find: /^@lifetimescriptkiddie\/shared-ptr-contract\/(.*)$/, replacement: pkg('contract/src/$1.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // No global execa mock: the choke-point in src/util/exec.ts refuses real
    // subprocess execution under vitest unless AGENTCTL_ALLOW_REAL_EXEC=1.
  },
});
