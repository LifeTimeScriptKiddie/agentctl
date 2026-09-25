/**
 * Monorepo-phase test adapters: what production does across a process boundary
 * (shared_ptr running `agentctl ask`, agentctl running `shared_ptr briefing`),
 * done in-process so tests can spy on adapters and use temp stores. Imports are
 * lazy so a test file's vi.mock calls still apply.
 */
import type { ServeModelRunner } from '../../packages/shared_ptr/src/turnModelGenerate.js';

/** shared_ptr → agentctl, in-process: the same registry and askOne the CLI uses. */
export async function useInProcessModelRunner(): Promise<void> {
  const { setServeModelRunner } = await import('../../packages/shared_ptr/src/turnModelGenerate.js');
  const { loadRegistry } = await import('../../src/core/loadRegistry.js');
  const { askOne } = await import('../../src/core/ask.js');
  const runner: ServeModelRunner = {
    async capabilities(agent) {
      const registry = loadRegistry();
      return registry.has(agent) ? registry.get(agent).capabilities() : null;
    },
    async ask({ agent, prompt, timeoutSeconds, workdir }) {
      const registry = loadRegistry();
      const r = await askOne(registry.resolveRole('chat', agent), prompt, timeoutSeconds, null, null, null, undefined, workdir);
      return { ok: r.ok, text: r.text, model: r.model, failureClass: r.failureClass };
    },
  };
  setServeModelRunner(runner);
}

/** agentctl → shared_ptr, in-process: the same store call `shared_ptr briefing` makes. */
export async function useInProcessBriefing(): Promise<void> {
  const { setLocalBriefingSource } = await import('../../src/memory/briefingProvider.js');
  const { MemoryStore } = await import('../../packages/shared_ptr/src/store.js');
  setLocalBriefingSource(async (workspace, provider, maxBytes) => {
    const store = await MemoryStore.open();
    try {
      return store.resumeBriefing(workspace, provider, maxBytes) as never;
    } finally {
      store.close();
    }
  });
}
