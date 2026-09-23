import type { Command } from 'commander';
import { loadRegistry } from '../core/loadRegistry.js';
import {
  formatSetupShow,
  planAutoSetup,
  probeAgents,
  resetPreferences,
  runInteractiveSetup,
  savePreferences,
} from './setup.js';
import type { CostTier } from '../core/preferences.js';

export function registerSetupCommands(program: Command): void {
  const setup = program
    .command('setup')
    .description('detect available agents and choose default models (run after install)');

  setup
    .option('--auto', 'non-interactive: probe PATH and pick optimized defaults', false)
    .option('--show', 'show current preferences and live availability', false)
    .option('--reset', 'delete $AGENTCTL_HOME/preferences.yaml', false)
    .option('--tier <tier>', 'economy | balanced | frontier', 'balanced')
    .option('--format <fmt>', 'text | json', 'text')
    .action(async (opts: {
      auto: boolean;
      show: boolean;
      reset: boolean;
      tier: string;
      format: string;
    }) => {
      try {
        if (opts.reset) {
          const removed = resetPreferences();
          const payload = { ok: true, reset: removed, path: 'preferences.yaml' };
          if (opts.format === 'json') console.log(JSON.stringify(payload, null, 2));
          else console.error(removed ? 'Removed preferences.yaml' : 'No preferences.yaml to remove');
          return;
        }

        const registry = loadRegistry();
        const tier = (['economy', 'balanced', 'frontier'].includes(opts.tier)
          ? opts.tier
          : 'balanced') as CostTier;

        if (opts.show) {
          const probes = await probeAgents(registry);
          if (opts.format === 'json') {
            console.log(JSON.stringify({ probes, lines: formatSetupShow(registry, probes) }, null, 2));
          } else {
            for (const line of formatSetupShow(registry, probes)) console.log(line);
          }
          return;
        }

        const plan = opts.auto || !process.stdin.isTTY
          ? planAutoSetup(await probeAgents(registry), { tier, source: 'auto' })
          : await runInteractiveSetup(registry, { tier });

        const path = savePreferences(plan.preferences);
        if (opts.format === 'json') {
          console.log(JSON.stringify({ ok: true, path, preferences: plan.preferences, summary: plan.summary }, null, 2));
          return;
        }
        console.error(`Wrote ${path}\n`);
        for (const line of plan.summary) console.error(`  ${line}`);
        console.error('\nOverrides still work: --to / --model / --orchestrator on each command.');
        console.error('Re-run `agentctl setup` anytime, or `agentctl setup --show` to inspect.');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (opts.format === 'json') console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
        else console.error(msg);
        process.exitCode = 1;
      }
    });
}
