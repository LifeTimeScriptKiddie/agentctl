import type { Command } from 'commander';

/**
 * Team-memory commands that stay in agentctl: HTTP clients of a shared_ptr
 * gatekeeper. Every other `agentctl memory …` is passed to the shared_ptr CLI
 * (see runMemoryPassthrough), which owns the store.
 */
export function registerMemoryClientCommands(program: Command): void {
  const memory = program.command('memory')
    .description('team memory: `memory gateway …` talks to a shared_ptr gatekeeper; anything else runs `shared_ptr …`');
  const gateway = memory.command('gateway')
    .description('call team gatekeeper HTTP API (requires AGENTCTL_GATEWAY_URL)');
  gateway.command('review').requiredOption('--workspace <id>')
    .action(async o => {
      const { getGatewayReview, resolveGatewayUrl } = await import('./gatewayClient.js');
      const base = resolveGatewayUrl();
      if (!base) {
        console.error(JSON.stringify({ error: 'Set AGENTCTL_GATEWAY_URL' }));
        process.exitCode = 2;
        return;
      }
      try {
        console.log(JSON.stringify(await getGatewayReview(base, o.workspace), null, 2));
      } catch (e) {
        console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        process.exitCode = 1;
      }
    });
  gateway.command('write')
    .requiredOption('--workspace <id>')
    .requiredOption('--text <text>')
    .requiredOption('--source <reference>')
    .option('--mode <mode>', 'propose | commit', 'propose')
    .option('--human-approved', 'required for commit', false)
    .action(async o => {
      const { postGatewayWrite, resolveGatewayUrl } = await import('./gatewayClient.js');
      const base = resolveGatewayUrl();
      if (!base) {
        console.error(JSON.stringify({ error: 'Set AGENTCTL_GATEWAY_URL' }));
        process.exitCode = 2;
        return;
      }
      try {
        const out = await postGatewayWrite(base, {
          mode: o.mode === 'commit' ? 'commit' : 'propose',
          workspace: o.workspace,
          text: o.text,
          source: o.source,
          human_approved: Boolean(o.humanApproved),
        });
        console.log(JSON.stringify(out, null, 2));
        if (out.status === 'rejected' || out.status === 'review_required') process.exitCode = 1;
      } catch (e) {
        console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        process.exitCode = 1;
      }
    });
  gateway.command('accept')
    .requiredOption('--workspace <id>')
    .requiredOption('--id <uuid>')
    .requiredOption('--revision <n>')
    .option('--human-approved', 'required', true)
    .action(async o => {
      const { postGatewayAccept, resolveGatewayUrl } = await import('./gatewayClient.js');
      const base = resolveGatewayUrl();
      if (!base) {
        console.error(JSON.stringify({ error: 'Set AGENTCTL_GATEWAY_URL' }));
        process.exitCode = 2;
        return;
      }
      try {
        console.log(JSON.stringify(await postGatewayAccept(base, {
          workspace: o.workspace,
          memory_id: o.id,
          revision: Number(o.revision),
          human_approved: Boolean(o.humanApproved),
        }), null, 2));
      } catch (e) {
        console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        process.exitCode = 1;
      }
    });
}
