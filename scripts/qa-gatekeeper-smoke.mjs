#!/usr/bin/env node
/**
 * Manual QA smoke: SQLite gatekeeper + thin-client env (no live LLM).
 * Usage: node scripts/qa-gatekeeper-smoke.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'cli.js');

const results = [];
function pass(name, detail = '') {
  results.push({ name, ok: true, detail });
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail) {
  results.push({ name, ok: false, detail });
  console.error(`✗ ${name} — ${detail}`);
}

async function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
      cwd: root,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || stdout || `exit ${code}`));
      else resolve(stdout);
    });
  });
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), 'agentctl-qa-'));
  const baseEnv = { AGENTCTL_HOME: home };
  try {
    await runCli([
      'memory', 'save', '--workspace', 'team-qa', '--text', 'QA seed: rollback owner is platform lead',
      '--source', 'qa:smoke', '--key', 'qa-seed-1', '--accept', '--providers', 'cursor',
    ], baseEnv);
    pass('CLI memory save (seed)');

    const { createMemoryServerForTest } = await import(pathToFileURL(join(root, 'dist', 'memory', 'serve.js')).href);
    const server = createMemoryServerForTest();
    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.on('error', reject);
    });
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    process.env.AGENTCTL_HOME = home;

    const health = await fetch(`${base}/health`);
    if (!health.ok) throw new Error(`health ${health.status}`);
    pass('GET /health');

    const turn = await fetch(`${base}/v1/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agentctl-user-id': 'qa@local' },
      body: JSON.stringify({
        workspace: 'team-qa',
        query: 'rollback owner platform',
        provider: 'cursor',
        goal: 'QA turn',
      }),
    });
    const turnJson = await turn.json();
    if (turn.status !== 200 || turnJson.status !== 'context_ready') {
      throw new Error(`turn ${turn.status} ${JSON.stringify(turnJson)}`);
    }
    pass('POST /v1/turn', `items=${turnJson.context_bundle?.items?.length ?? 0} status=${turnJson.status}`);

    const write = await fetch(`${base}/v1/memory/write`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'propose',
        workspace: 'team-qa',
        text: 'QA proposed memory',
        source: 'qa:write',
        key: 'qa-propose-1',
      }),
    });
    const writeJson = await write.json();
    if (write.status !== 200 || writeJson.status !== 'proposed') {
      throw new Error(`write ${write.status}`);
    }
    pass('POST /v1/memory/write (propose)');

    const review = await fetch(`${base}/v1/memory/review?workspace=team-qa`);
    const reviewJson = await review.json();
    if (review.status !== 200 || !reviewJson.proposed?.length) {
      throw new Error('review empty');
    }
    pass('GET /v1/memory/review', `count=${reviewJson.proposed.length}`);

    const mem = writeJson.memory;
    const accept = await fetch(`${base}/v1/memory/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace: 'team-qa',
        memory_id: mem.id,
        revision: mem.revision,
        human_approved: true,
      }),
    });
    const acceptJson = await accept.json();
    if (accept.status !== 200 || acceptJson.memory?.state !== 'accepted') {
      throw new Error(`accept ${accept.status}`);
    }
    pass('POST /v1/memory/accept');

    await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));

    const pgStatus = await runCli(['memory', 'postgres', 'status'], baseEnv);
    JSON.parse(pgStatus);
    pass('CLI memory postgres status');

    const pgDry = await runCli(['memory', 'postgres', 'migrate', '--dry-run'], {
      ...baseEnv,
      AGENTCTL_MEMORY_BACKEND: 'postgres',
      AGENTCTL_MEMORY_DATABASE_URL: 'postgres://127.0.0.1:5432/qa_unused',
    });
    const dry = JSON.parse(pgDry);
    if (!dry.pending?.includes('001_core')) throw new Error('migrate dry-run');
    pass('CLI memory postgres migrate --dry-run');

    process.env.AGENTCTL_HOME = home;
    const { buildWorkerPrompt } = await import(pathToFileURL(join(root, 'dist', 'memory', 'briefingPrompt.js')).href);
    const server2 = createMemoryServerForTest();
    await new Promise((resolve, reject) => {
      server2.listen(0, '127.0.0.1', () => resolve());
      server2.on('error', reject);
    });
    const gwPort = server2.address().port;
    const prefix = await buildWorkerPrompt({
      agent: 'cursor',
      userPrompt: 'Who owns rollback?',
      briefingWorkspace: 'team-qa',
      gatewayUrl: `http://127.0.0.1:${gwPort}`,
    });
    if (!prefix.includes('Team context') && !prefix.toLowerCase().includes('rollback')) {
      throw new Error('gateway prefix missing context');
    }
    pass('buildWorkerPrompt + live /v1/turn prefix');
    await new Promise((resolve, reject) => server2.close((e) => (e ? reject(e) : resolve())));

    const failed = results.filter((r) => !r.ok);
    console.log('\n---');
    console.log(`QA smoke: ${results.length - failed.length}/${results.length} passed`);
    if (failed.length) process.exit(1);
  } catch (e) {
    fail('QA smoke', e instanceof Error ? e.message : String(e));
    console.log('\n---');
    console.log(`QA smoke: ${results.filter((r) => r.ok).length}/${results.length} passed (aborted)`);
    process.exit(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

main();
