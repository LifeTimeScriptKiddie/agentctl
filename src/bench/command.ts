import type { Command } from 'commander';
import { buildJsonEnvelope } from '../format/output.js';
import { loadRegistry } from '../core/loadRegistry.js';
import { FEATURES, featureEnabled, loadPreferences, routingPrefer, savePreferences } from '../core/preferences.js';
import { agentAsk, agentDelegate } from '../api.js';
import { runDoctor, formatDoctor } from '../doctor.js';
import { detectCallerContext } from '../core/caller.js';
import { parseSince } from '../graph/command.js';
import { benchRoster, loadCases, runLiveBench, runRoutingBench } from './bench.js';
import { rollbackTune, tune } from './tune.js';
import { loadEffortCases, runEffortSweep, saveEffortSweep, seedEffortCases } from './effort.js';
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

  program.command('bench-effort')
    .alias('effort-sweep')
    .description('run your own tasks on one lane at several effort levels; compare pass rate, tokens, cost, time (spends quota)')
    .option('--lane <agent>', 'lane to sweep', 'claude')
    .option('--levels <list>', 'comma-separated effort levels', 'low,medium,high,xhigh')
    .option('--model <model>', 'model for every call (default: the lane default)')
    .option('--limit <n>', 'use only the first n cases')
    .option('--cases <file>', 'cases file (default: $AGENTCTL_HOME/bench/effort-cases.yaml)')
    .option('--seed <n>', 'draft n cases from your recent jobs into the private cases file, then stop')
    .option('--force', 'with --seed: replace an existing cases file', false)
    .option('--timeout <seconds>', 'per call', '300')
    .option('--format <format>', 'text | json', 'text')
    .action((o: { lane: string; levels: string; model?: string; limit?: string; cases?: string; seed?: string; force: boolean; timeout: string; format: Format }) =>
      guard('bench-effort', () => o.format, async () => {
        if (o.seed) {
          const r = seedEffortCases(Number(o.seed), { force: o.force });
          out('bench-effort', o.format, 0, { path: r.path, cases: r.cases.length },
            `drafted ${r.cases.length} case(s) in ${r.path}\nreview them (delete unusable ones, add contains/regex checks), then run: agentctl bench-effort --lane ${o.lane}`);
          return;
        }
        const registry = loadRegistry();
        const preset = registry.getPreset(o.lane);
        if (!preset) throw new Error(`no lane '${o.lane}'`);
        const levels = o.levels.split(',').map((x) => x.trim()).filter(Boolean);
        const offered = preset.effort?.options ?? [];
        const unknown = levels.filter((l) => !offered.includes(l));
        if (!preset.effort) throw new Error(`lane '${o.lane}' has no effort control`);
        if (unknown.length) throw new Error(`lane '${o.lane}' offers ${offered.join('|')}; not: ${unknown.join(', ')}`);
        let cases = o.cases ? loadEffortCases(o.cases) : loadEffortCases();
        if (o.limit) cases = cases.slice(0, Number(o.limit));
        const sweep = await runEffortSweep(cases, levels, async (task, effort) => {
          const r = await agentAsk(registry, { to: o.lane, prompt: task, effort, model: o.model ?? null, timeoutSeconds: Number(o.timeout) });
          const a = r.results[0];
          return { ok: Boolean(a?.ok), text: a?.text ?? r.error ?? '', outputTokens: a?.usage.outputTokens ?? null,
            costUsd: a?.costUsd ?? a?.usage.costUsd ?? null, model: a?.model ?? null };
        });
        const saved = saveEffortSweep({ lane: o.lane, model: o.model ?? null, cases: cases.length, ...sweep });
        const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
        const lines = [
          `effort sweep on ${o.lane}${o.model ? ` (${o.model})` : ''}: ${cases.length} case(s) × ${levels.length} level(s)`,
          'level    ok    pass(checked)   median out tokens   median cost   median time',
          ...sweep.levels.map((l) => [
            l.effort.padEnd(8), pct(l.okRate).padEnd(5), `${pct(l.passRate)} (${l.checked})`.padEnd(15),
            String(l.medianOutputTokens ?? '—').padEnd(19), (l.medianCostUsd === null ? '—' : `$${l.medianCostUsd}`).padEnd(13), `${l.medianSeconds}s`,
          ].join(' ')),
          `saved: ${saved}`,
        ];
        out('bench-effort', o.format, 0, { ...sweep, saved }, lines.join('\n'));
      }));

  program.command('doctor')
    .description('check setup, each tool, recent failures, sandbox/caller and MCP installs; prints the next step for each problem')
    .option('--live', 'send one tiny prompt per enabled tool to prove its login (spends a little quota)', false)
    .option('--format <format>', 'text | json', 'text')
    .action((o: { live: boolean; format: Format }) => guard('doctor', () => o.format, async () => {
      const registry = loadRegistry();
      const caller = await detectCallerContext();
      const checks = await runDoctor({
        registry, caller,
        ...(o.live && !caller.sandboxNoNetwork ? {
          live: async (lane: string) => {
            const r = await agentAsk(registry, { to: lane, prompt: 'Reply with the single word OK.', timeoutSeconds: 90 });
            const first = r.results[0];
            return { ok: Boolean(first?.ok), detail: first?.text || r.error || 'no answer' };
          },
        } : {}),
      });
      const failed = checks.some((c) => c.status === 'fail');
      out('doctor', o.format, failed ? 1 : 0, { checks }, formatDoctor(checks));
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
