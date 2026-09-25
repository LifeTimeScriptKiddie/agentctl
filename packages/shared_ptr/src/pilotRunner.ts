import { execa } from 'execa';
import type { PilotRunner } from './pilot.js';

/** Pilot worker calls through the public agentctl CLI (shared_ptr embeds no agent code). */
export function agentctlCliPilotRunner(opts: { agent: string; model: string; timeoutSeconds: number }): PilotRunner {
  const bin = process.env.SHARED_PTR_AGENTCTL_BIN?.trim() || 'agentctl';
  return async (prompt, workdir) => {
    const r = await execa(bin, ['ask', '--to', opts.agent, '--allow-self', '--model', opts.model,
      '--timeout', String(opts.timeoutSeconds), '--format', 'json'], {
      input: prompt, cwd: workdir, reject: false, timeout: (opts.timeoutSeconds + 30) * 1000,
    });
    try {
      const env = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as {
        result?: { results?: Array<{ ok: boolean; text: string; model: string | null; failureClass: string; usage?: unknown }> };
      };
      const first = env.result?.results?.[0];
      if (first) return { ok: first.ok, normalizedText: first.text, failureClass: first.failureClass, model: first.model, usage: first.usage ?? null };
    } catch { /* fall through */ }
    return { ok: false, normalizedText: '', failureClass: 'agentctl_failed', model: null, usage: null };
  };
}
