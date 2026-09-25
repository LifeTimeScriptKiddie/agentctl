import type { Command } from 'commander';
import { buildJsonEnvelope } from '../format/output.js';
import { loadRegistry } from '../core/loadRegistry.js';
import { FEATURES, featureEnabled, loadPreferences, routingPrefer, savePreferences } from '../core/preferences.js';
import { agentDelegate } from '../api.js';
import { parseSince } from '../graph/command.js';
import { benchRoster, loadCases, runLiveBench, runRoutingBench } from './bench.js';
import { rollbackTune, tune } from './tune.js';
import { loadLimits, pruneExpired, updateLimits } from '../core/limitStore.js';

type Format = 'text' | 'json';

function out(command: string, format: Format, exitCode: number, result: unknown, text: string, error?: string): void {
  if (format === 'json') process.stdout.write(`${JSON.stringify(buildJsonEnvelope(command, exitCode, [], result, error))}\n`);
  else process.stdout.write(`${error ? `error: ${error}` : text}\n`);
  process.exitCode = exitCode;
}

function guard(command: string, format: () => Format, fn: () => Promise<void> | void): Promise<void> {
  return (async () => {
    try { await fn(); } catch (e) { out(command, format(), 2, undefined, '', e instanceof Error ? e.message : String(e)); }
  })();
}

export function registerBenchCommands(program: Command): void {
  program.command('bench')
    .description('score routing against the fixed benchmark (hard invariants + soft expectations); --live adds real calls')
    .option('--live', 'also run the live cases through delegate (spends quota)', false)
    .option('--timeout <seconds>', 'per live call', '120')
    .option('--format <format>', 'text | json', 'text')
    .action((o: { live: boolean; timeout: string; format: Format }) => guard('bench', () => o.format, async () => {
      const cases = loadCases();
      const registry = loadRegistry();
      const routing = runRoutingBench(cases.routing, benchRoster(registry), routingPrefer(loadPreferences()));
      const live = o.live
        ? await runLiveBench(cases.live, async (task) => {
          const r = await agentDelegate(registry, { task, timeoutSeconds: Number(o.timeout) });
          return { agent: r.ask?.agent ?? r.route.agent, ok: Boolean(r.ask?.ok), text: r.ask?.text ?? r.error ?? '' };
        })
        : null;
      const failed = routing.failed.length > 0 || (live !== null && live.passed < live.total);
      const lines = [
        `routing: ${routing.passed}/${routing.total} hard invariants pass; ${routing.softMet}/${routing.softTotal} intended lanes`,
        ...routing.cases.filter((c) => c.violations.length).map((c) => `  ✗ ${c.id}: ${c.violations.join('; ')}`),
        ...routing.cases.filter((c) => c.expect && !c.expectMet).map((c) => `  ~ ${c.id}: ${c.agent ?? 'none'} (intended ${c.expect})`),
        ...(live ? [`live: ${live.passed}/${live.total} pass`,
          ...live.cases.map((c) => `  ${c.passed ? '✓' : '✗'} ${c.id} → ${c.agent ?? 'none'} (${Math.round(c.durationMs / 1000)}s)${c.passed ? '' : `: ${c.detail}`}`)] : []),
      ];
      out('bench', o.format, failed ? 1 : 0, { routing, live }, lines.join('\n'));
    }));

  program.command('features')
    .description('list optional features, or switch one: agentctl features <name> on|off')
    .argument('[name]', `one of: ${FEATURES.map((f) => f.name).join(', ')}`)
    .argument('[state]', 'on | off')
    .option('--format <format>', 'text | json', 'text')
    .action((name: string | undefined, state: string | undefined, o: { format: Format }) => guard('features', () => o.format, () => {
      const prefs = loadPreferences();
      if (name) {
        const f = FEATURES.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (!f) throw new Error(`unknown feature '${name}'; one of: ${FEATURES.map((x) => x.name).join(', ')}`);
        if (state !== 'on' && state !== 'off') throw new Error(`say 'on' or 'off': agentctl features ${f.name} on|off`);
        if (!prefs) throw new Error('no preferences yet — run `agentctl setup` first');
        savePreferences({ ...prefs, updatedAt: new Date().toISOString(), features: { ...prefs.features, [f.name]: state === 'on' } });
        out('features', o.format, 0, { [f.name]: state === 'on' }, `${f.name} is now ${state}`);
        return;
      }
      const rows = FEATURES.map((f) => ({ ...f, on: featureEnabled(f.name, prefs) }));
      out('features', o.format, 0, Object.fromEntries(rows.map((r) => [r.name, r.on])),
        rows.map((r) => `${r.on ? '●' : '○'} ${r.name.padEnd(14)} ${r.on ? 'on ' : 'off'}  ${r.summary}`).join('\n')
          + '\n\nswitch: agentctl features <name> on|off');
    }));

  program.command('limits')
    .description('show cached usage caps; --clear [lane] forgets them (e.g. after a mis-detected limit)')
    .option('--clear [lane]', 'clear every cap, or only this lane / quota account')
    .option('--format <format>', 'text | json', 'text')
    .action((o: { clear?: string | boolean; format: Format }) => guard('limits', () => o.format, () => {
      const now = new Date();
      if (o.clear !== undefined) {
        const lane = typeof o.clear === 'string' ? o.clear : null;
        let removed: string[] = [];
        updateLimits((m) => {
          removed = Object.keys(m).filter((k) => !lane || k.startsWith(`${lane}:`));
          return Object.fromEntries(Object.entries(m).filter(([k]) => !removed.includes(k)));
        });
        out('limits', o.format, 0, { removed }, removed.length ? `cleared ${removed.join(', ')}` : 'nothing to clear');
        return;
      }
      const active = Object.entries(pruneExpired(loadLimits(), now));
      out('limits', o.format, 0, Object.fromEntries(active),
        active.length ? active.map(([k, v]) => `${k}  until ${v.until}  (via ${v.via})`).join('\n') : 'no active usage caps');
    }));

  program.command('tune')
    .description('config-only loop: propose routing.prefer reorders from outcome evidence, gated on the benchmark')
    .option('--apply', 'write the change to preferences.yaml (backed up; undo with --rollback)', false)
    .option('--rollback', 'restore preferences.yaml from before the last applied tune', false)
    .option('--force', 'with --rollback: restore even if routing.prefer was edited since', false)
    .option('--scheduled', 'for the weekly job: only --apply when the selfTune feature is on', false)
    .option('--since <window>', 'evidence window (7d, 24h, ISO date)', '30d')
    .option('--format <format>', 'text | json', 'text')
    .action((o: { apply: boolean; rollback: boolean; force: boolean; scheduled: boolean; since: string; format: Format }) => guard('tune', () => o.format, () => {
      if (o.rollback) {
        const r = rollbackTune(undefined, undefined, o.force);
        out('tune', o.format, 0, r, `rolled back the tune from ${r.changes.map((c) => c.signal).join(', ')} (restored ${r.backup})`);
        return;
      }
      const registry = loadRegistry();
      const apply = o.apply && (!o.scheduled || featureEnabled('selfTune'));
      const r = tune({ cases: loadCases().routing, roster: benchRoster(registry), apply, sinceMs: parseSince(o.since) });
      const lines = [
        ...Object.entries(r.evidence)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([n, l]) => `  ${n.padEnd(12)} verified ${l.verified}/${l.verified + l.rejected}  calls ok ${l.calls - l.callFailures}/${l.calls}`),
      ];
      lines.unshift(`evidence (since ${o.since}):`);
      if (r.changes.length === 0) lines.push('no change proposed: no signal is led by a lane with enough bad verdicts');
      for (const c of r.changes) lines.push(`${c.signal}: [${c.from.join(', ')}] → [${c.to.join(', ')}]  — ${c.why}`);
      lines.push(`bench: ${r.bench.before.passed}/${r.bench.before.total} → ${r.bench.after.passed}/${r.bench.after.total} hard invariants`);
      if (r.regressions.length) lines.push(`dropped (would break a hard bench case): ${r.regressions.join(', ')}`);
      if (r.applied) lines.push(`applied to preferences.yaml (backup ${r.backup}); undo: agentctl tune --rollback`);
      else if (r.changes.length && o.apply && !apply) lines.push('not applied: selfTune is off (turn it on with `agentctl features selfTune on`)');
      else if (r.changes.length) lines.push('dry run: re-run with --apply to write it');
      out('tune', o.format, r.regressions.length && !r.changes.length ? 1 : 0, r, lines.join('\n'));
    }));
}
