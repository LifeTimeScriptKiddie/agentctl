/** Explicit, bounded live smoke. Uses real provider quota only with --run. */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import assert from 'node:assert/strict';
import { ReplSession } from '../dist/repl.js';
import { AdapterRegistry } from '../dist/adapters/registry.js';
import { savePreferences } from '../dist/core/preferences.js';
import { newSession, saveSession, loadSession } from '../dist/core/session.js';

if (!process.argv.includes('--run')) {
  console.log('Usage: node scripts/live-chat-smoke.mjs --run [--delegation-only [--single-worker]]\nUses up to 8 logical provider calls (4 for delegation-only, 3 with --single-worker), read-only synthetic tasks, no web.');
  process.exit(0);
}
const delegationOnly = process.argv.includes('--delegation-only');
const singleWorker = process.argv.includes('--single-worker');
if (singleWorker && !delegationOnly) throw new Error('--single-worker requires --delegation-only');
const evidenceRoot = join(homedir(), '.agentctl', 'chat-validation');
mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
const home = mkdtempSync(join(evidenceRoot, 'lead-'));
process.env.AGENTCTL_HOME = home;
delete process.env.AGENTCTL_BRIEFING_WORKSPACE;
delete process.env.AGENTCTL_GATEWAY_URL;
savePreferences({ version: 1, updatedAt: new Date().toISOString(), source: 'manual', tier: 'balanced',
  orchestrator: { agent: 'cursor', model: 'composer-2.5' }, agents: {},
});
const packaged = AdapterRegistry.fromPackaged();
const registry = new AdapterRegistry(['cursor','claude','codex'].map(n => packaged.getPreset(n)));
const record = newSession(Date.now(), 'live-smoke', 'synthetic-live-check');
const options = { session: record, persist: r => saveSession(r, Date.now()), timeoutSeconds: 45,
  onProgress: text => console.log(text) };
const session = new ReplSession(registry, options);
const results = [];
const run = async (name, fn) => {
  const start = Date.now();
  try { await fn(); results.push({ name, passed: true, durationMs: Date.now() - start }); }
  catch (e) { results.push({ name, passed: false, error: String(e), durationMs: Date.now() - start }); }
  console.log(JSON.stringify(results.at(-1)));
};
console.log(`Evidence: ${home}`);
if (!delegationOnly) await run('ordinary reply without delegation', async () => {
  const r = await session.handle('What is 17 plus 25? Answer briefly yourself; do not delegate or read files.');
  assert(r.outputs.join('\n').includes('42'), r.outputs.join('\n'));
});
await run(singleWorker ? 'lead delegates one task and returns its result' : 'lead delegates two tasks and returns their results', async () => {
  const r = await session.handle(singleWorker
    ? 'Explicitly delegate exactly one task to claude: calculate 17 plus 25. Then tell me the actual worker result. No file reads, web, or shell commands.'
    : 'This is a delegation smoke check. Explicitly delegate exactly two independent tasks: ask claude to calculate 17 plus 25, and ask codex to calculate 7 times 8. Then tell me both results. No file reads, web, or shell commands.');
  const saved = loadSession(record.id);
  assert.equal(saved.chat.tasks.length, singleWorker ? 1 : 2, r.outputs.join('\n'));
  assert(saved.chat.tasks.every(t => t.status === 'done'), JSON.stringify(saved.chat.tasks));
  assert(r.outputs.join('\n').includes('42') && (singleWorker || r.outputs.join('\n').includes('56')), r.outputs.join('\n'));
});
if (!delegationOnly) await run('fresh resume retains handoffs and answers a follow-up', async () => {
  const resumed = new ReplSession(registry, { ...options, session: loadSession(record.id) });
  const tasks = await resumed.handle('/tasks');
  assert(tasks.outputs.join('\n').includes('[done]'));
  const r = await resumed.handle('What two numbers did the delegated agents just calculate? Answer yourself from the saved results; do not delegate.');
  assert(r.outputs.join('\n').includes('42') && r.outputs.join('\n').includes('56'), r.outputs.join('\n'));
});
if (!delegationOnly) await run('live cancellation returns cleanly', async () => {
  session.beginTurn();
  const timer = setTimeout(() => session.requestCancel(), 1000);
  try {
    const r = await session.handle('Explain in detail the differences between breadth-first and depth-first traversal. Answer yourself without tools.');
    assert(r.outputs.join('\n').includes('cancelled'), r.outputs.join('\n'));
    assert(!r.outputs.join('\n').includes('JSON object'));
  } finally { clearTimeout(timer); session.endTurn(); }
});
const trace = join(home, 'chat-traces', `${record.id}.jsonl`);
const calls = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.kind === 'tool_call').length;
const report = `# Live lead-chat smoke\n\nTrace: ${trace}\nLogical provider calls: ${calls}\n\n` + results.map(r =>
  `- ${r.passed ? 'PASS' : 'FAIL'} ${r.name} (${r.durationMs} ms)${r.error ? `: ${r.error}` : ''}`).join('\n') + '\n';
writeFileSync(join(home, 'REPORT.md'), report, { mode: 0o600 });
console.log(report);
process.exitCode = results.every(r => r.passed) && calls <= (singleWorker ? 3 : delegationOnly ? 4 : 8) ? 0 : 1;
