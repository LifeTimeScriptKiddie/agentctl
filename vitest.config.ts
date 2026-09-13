import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // No global execa mock: the choke-point in src/util/exec.ts refuses real
    // subprocess execution under vitest unless AGENTCTL_ALLOW_REAL_EXEC=1.
  },
});
