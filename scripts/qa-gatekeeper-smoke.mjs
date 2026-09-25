#!/usr/bin/env node
/**
 * Manual QA smoke: SQLite gatekeeper + thin-client env (no live LLM).
 * Usage: node scripts/qa-gatekeeper-smoke.mjs
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'cli.js');
const dist = (path) => import(pathToFileURL(join(root, 'dist', path)).href);
// team-memory server code lives in the shared_ptr package since the split
const sharedPtrDist = (path) => import(pathToFileURL(join(root, 'packages', 'shared_ptr', 'dist', path)).href);

// Identity comes from bearer tokens only (security review S5); start from a clean env.
for (const name of [
  'AGENTCTL_SERVE_TOKEN', 'AGENTCTL_SERVE_ALLOW_ANON', 'AGENTCTL_GATEWAY_TOKEN', 'AGENTCTL_GATEWAY_URL',
  'AGENTCTL_USER_ID', 'AGENTCTL_GROUPS', 'AGENTCTL_CLEARANCE', 'AGENTCTL_MEMORY_REVIEWER_GROUPS',
  'AGENTCTL_MEMORY_BACKEND', 'AGENTCTL_SERVE_MODEL_AGENT', 'AGENTCTL_GATEWAY_RUN_MODEL',
]) {
  delete process.env[name];
}
process.env.AGENTCTL_LAYA_WARM = '0';

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

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const close = (server) => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
const bearer = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });

async function expectStatus(name, response, status, error) {
  const body = await response.json();
  if (response.status !== status || (error && body.error !== error)) {
    throw new Error(`${name}: expected ${status} ${error ?? ''}, got ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), 'agentctl-qa-'));
  const ownerHome = mkdtempSync(join(tmpdir(), 'agentctl-qa-owner-'));
  const baseEnv = { AGENTCTL_HOME: home };
  try {
    await runCli([
      'memory', 'save', '--workspace', 'team-qa', '--text', 'QA seed: rollback owner is platform lead',
      '--source', 'qa:smoke', '--key', 'qa-seed-1', '--accept', '--providers', 'cursor',
    ], baseEnv);
    pass('CLI memory save (seed)');

    const issue = async (user, groups) => JSON.parse(await runCli([
      'memory', 'serve', 'token', 'add', '--user', user, '--groups', groups,
    ], baseEnv)).token;
    const proposer = await issue('qa-proposer@local', 'qa-team');
    const reviewer = await issue('qa-reviewer@local', 'qa-reviewers');
    const listed = await runCli(['memory', 'serve', 'token', 'list'], baseEnv);
    if (listed.includes(proposer) || JSON.parse(listed).tokens.length !== 2) throw new Error('token list');
    pass('CLI memory serve token add/list', 'secrets not listed');

    const { createMemoryServerForTest, startMemoryServer } = await sharedPtrDist('serve.js');
    process.env.AGENTCTL_HOME = home;
    process.env.AGENTCTL_MEMORY_REVIEWER_GROUPS = 'qa-reviewers';
    const server = createMemoryServerForTest();
    const base = await listen(server);

    const health = await fetch(`${base}/health`);
    if (!health.ok) throw new Error(`health ${health.status}`);
    pass('GET /health');

    const turnBody = JSON.stringify({ workspace: 'team-qa', query: 'rollback owner platform', provider: 'cursor', goal: 'QA turn' });
    await expectStatus('no token', await fetch(`${base}/v1/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: turnBody,
    }), 401, 'token_required');
    await expectStatus('unknown token', await fetch(`${base}/v1/turn`, {
      method: 'POST', headers: bearer('not-issued'), body: turnBody,
    }), 401, 'unauthorized');
    await expectStatus('identity header', await fetch(`${base}/v1/turn`, {
      method: 'POST', headers: { ...bearer(proposer), 'x-agentctl-user-id': 'qa-reviewer@local' }, body: turnBody,
    }), 400, 'identity_headers_not_supported');
    pass('token required; unknown token 401; identity headers 400');

    const turnJson = await expectStatus('turn', await fetch(`${base}/v1/turn`, {
      method: 'POST', headers: bearer(proposer), body: turnBody,
    }), 200);
    if (turnJson.status !== 'context_ready' || !turnJson.context_bundle?.items?.length) {
      throw new Error(`turn ${JSON.stringify(turnJson)}`);
    }
    pass('POST /v1/turn', `items=${turnJson.context_bundle.items.length} status=${turnJson.status}`);

    const propose = async (token, key) => (await expectStatus('write', await fetch(`${base}/v1/memory/write`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ mode: 'propose', workspace: 'team-qa', text: `QA proposed memory ${key}`, source: 'qa:write', key }),
    }), 200)).memory;
    const mem = await propose(proposer, 'qa-propose-1');
    if (mem.state !== 'proposed' || mem.proposedBy !== 'qa-proposer@local') throw new Error(`write ${JSON.stringify(mem)}`);
    pass('POST /v1/memory/write (propose)', `proposedBy=${mem.proposedBy}`);

    const reviewJson = await expectStatus('review', await fetch(`${base}/v1/memory/review?workspace=team-qa`, {
      headers: bearer(reviewer),
    }), 200);
    if (!reviewJson.proposed?.length) throw new Error('review empty');
    pass('GET /v1/memory/review', `count=${reviewJson.proposed.length}`);

    const accept = (token, memory) => fetch(`${base}/v1/memory/accept`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ workspace: 'team-qa', memory_id: memory.id, revision: memory.revision, human_approved: true }),
    });
    await expectStatus('accept by non-reviewer', await accept(proposer, mem), 403, 'reviewer_required');
    const own = await propose(reviewer, 'qa-propose-2');
    await expectStatus('self-accept', await accept(reviewer, own), 403, 'self_accept_forbidden');
    pass('accept refused for non-reviewer and for self-acceptance');

    const acceptJson = await expectStatus('accept', await accept(reviewer, mem), 200);
    if (acceptJson.memory?.state !== 'accepted') throw new Error(`accept ${JSON.stringify(acceptJson)}`);
    pass('POST /v1/memory/accept');

    await close(server);

    const pgStatus = await runCli(['memory', 'postgres', 'status'], baseEnv);
    JSON.parse(pgStatus);
    pass('CLI memory postgres status');

    const pgDry = await runCli(['memory', 'postgres', 'migrate', '--dry-run'], {
      ...baseEnv,
      AGENTCTL_MEMORY_BACKEND: 'postgres',
      AGENTCTL_MEMORY_DATABASE_URL: 'postgres://127.0.0.1:5432/qa_unused',
    });
    const dry = JSON.parse(pgDry);
    for (const id of ['001_core', '003_proposed_by', '004_checkpoint_acl']) {
      if (!dry.pending?.includes(id)) throw new Error(`migrate dry-run missing ${id}`);
    }
    pass('CLI memory postgres migrate --dry-run');

    const { buildWorkerPrompt } = await dist('memory/briefingPrompt.js');
    const server2 = createMemoryServerForTest();
    const gateway2 = await listen(server2);
    process.env.AGENTCTL_GATEWAY_TOKEN = proposer; // thin client: per-user token, no identity headers
    const prefix = await buildWorkerPrompt({
      agent: 'cursor',
      userPrompt: 'Who owns rollback?',
      briefingWorkspace: 'team-qa',
      gatewayUrl: gateway2,
    });
    if (!prefix.includes('Team context')) throw new Error('gateway prefix missing context');
    pass('buildWorkerPrompt + live /v1/turn prefix (per-user token)');
    await close(server2);
    delete process.env.AGENTCTL_GATEWAY_TOKEN;

    // No token configured: a loopback server generates the owner token and the client reads it.
    await runCli([
      'memory', 'save', '--workspace', 'team-qa', '--text', 'QA owner seed: rollback owner is the owner lead',
      '--source', 'qa:owner', '--key', 'qa-owner-1', '--accept', '--providers', 'cursor',
    ], { AGENTCTL_HOME: ownerHome });
    process.env.AGENTCTL_HOME = ownerHome;
    process.env.AGENTCTL_USER_ID = 'qa-owner@local';
    const originalStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    let ownerServer;
    try {
      ownerServer = await startMemoryServer({ host: '127.0.0.1', port: 0 });
    } finally {
      process.stderr.write = originalStderr;
    }
    const ownerBase = `http://127.0.0.1:${ownerServer.address().port}`;
    const tokenMode = statSync(join(ownerHome, 'serve-token')).mode & 0o777;
    if (tokenMode !== 0o600) throw new Error(`serve-token mode ${tokenMode.toString(8)}`);
    await expectStatus('owner server without token', await fetch(`${ownerBase}/v1/memory/review?workspace=team-qa`), 401, 'token_required');
    const ownerPrefix = await buildWorkerPrompt({
      agent: 'cursor',
      userPrompt: 'Who owns rollback?',
      briefingWorkspace: 'team-qa',
      gatewayUrl: ownerBase,
    });
    if (!ownerPrefix.includes('QA owner seed')) throw new Error('owner-token gateway prefix missing the owner memory');
    pass('auto-generated owner token (0600) required by server and used by gatewayClient on loopback');
    await close(ownerServer);

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
    rmSync(ownerHome, { recursive: true, force: true });
  }
}

main();
