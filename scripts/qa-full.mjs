#!/usr/bin/env node
/**
 * Full local QA: smoke + optional Docker Postgres + gateway delegate (dry_run).
 * Usage: node scripts/qa-full.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'cli.js');
const PG_CONTAINER = 'agentctl-qa-postgres';
const PG_PORT = 55432;
const PG_URL = `postgres://agentctl:qa@127.0.0.1:${PG_PORT}/team_memory`;

const log = [];
function ok(name, detail = '') {
  log.push({ name, pass: true, detail });
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
}
function bad(name, detail) {
  log.push({ name, pass: false, detail });
  console.error(`✗ ${name} — ${detail}`);
}

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || `${cmd} exit ${r.status}`);
  return r.stdout;
}

async function runAsync(cmd, args, env = {}, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => { stdout += c; });
    child.stderr?.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timeout after ${timeoutMs}ms: ${stderr || stdout}`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr || stdout || `exit ${code}`));
      else resolve(stdout);
    });
  });
}

async function runSmoke() {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'qa-gatekeeper-smoke.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  ok('qa-gatekeeper-smoke.mjs', '9 checks');
}

async function dockerPgUp() {
  spawnSync('docker', ['rm', '-f', PG_CONTAINER], { stdio: 'ignore' });
  const up = spawnSync(
    'docker',
    [
      'run', '-d', '--name', PG_CONTAINER,
      '-e', 'POSTGRES_USER=agentctl',
      '-e', 'POSTGRES_PASSWORD=qa',
      '-e', 'POSTGRES_DB=team_memory',
      '-p', `${PG_PORT}:5432`,
      'postgres:16-alpine',
    ],
    { encoding: 'utf8' },
  );
  if (up.status !== 0) throw new Error(up.stderr || 'docker run failed');
  for (let i = 0; i < 30; i++) {
    const ping = spawnSync(
      'docker',
      ['exec', PG_CONTAINER, 'pg_isready', '-U', 'agentctl', '-d', 'team_memory'],
      { encoding: 'utf8' },
    );
    if (ping.status === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('postgres not ready');
}

async function dockerPgDown() {
  spawnSync('docker', ['rm', '-f', PG_CONTAINER], { stdio: 'ignore' });
}

async function qaPostgres() {
  await dockerPgUp();
  try {
    const install = spawnSync('npm', ['install', 'pg@8.13.1', '--no-save'], { cwd: root, encoding: 'utf8' });
    if (install.status !== 0) throw new Error(install.stderr || 'npm install pg failed');

    const home = mkdtempSync(join(tmpdir(), 'agentctl-qa-pg-'));
    try {
      await runAsync(process.execPath, [cli, 'memory', 'postgres', 'migrate'], {
        AGENTCTL_HOME: home,
        AGENTCTL_MEMORY_BACKEND: 'postgres',
        AGENTCTL_MEMORY_DATABASE_URL: PG_URL,
      }, 60_000);
      ok('Postgres migrate (Docker)', PG_URL);

      process.env.AGENTCTL_HOME = home;
      process.env.AGENTCTL_MEMORY_BACKEND = 'postgres';
      process.env.AGENTCTL_MEMORY_DATABASE_URL = PG_URL;
      const { PostgresMemoryStore } = await import(
        pathToFileURL(join(root, 'dist', 'memory', 'postgres', 'memoryStorePostgres.js')).href
      );
      const store = await PostgresMemoryStore.open({ auth: null });
      await store.saveForGatekeeper({
        workspace: 'team-pg-qa',
        text: 'Postgres QA rollback owner platform',
        source: 'qa:pg',
        key: 'pg-k1',
        providers: ['cursor'],
        state: 'accepted',
      });
      const graph = await store.searchWithGraph('team-pg-qa', 'rollback owner', 'cursor', 5);
      if (graph.memories.length < 1) {
        throw new Error(`postgres search empty terminal=${graph.terminal}`);
      }
      ok('PostgresMemoryStore searchWithGraph', `hits=${graph.memories.length}`);
      await store.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
      delete process.env.AGENTCTL_MEMORY_BACKEND;
      delete process.env.AGENTCTL_MEMORY_DATABASE_URL;
    }
  } finally {
    await dockerPgDown();
  }
}

async function qaDelegateGateway() {
  const home = mkdtempSync(join(tmpdir(), 'agentctl-qa-del-'));
  try {
    run(process.execPath, [
      cli, 'memory', 'save', '--workspace', 'team-qa', '--text', 'Delegate QA: enrollment blocker is auth team',
      '--source', 'qa:del', '--key', 'del-k1', '--accept', '--providers', 'cursor',
    ], { AGENTCTL_HOME: home });

    const { createMemoryServerForTest } = await import(pathToFileURL(join(root, 'dist', 'memory', 'serve.js')).href);
    const server = createMemoryServerForTest();
    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.on('error', reject);
    });
    const port = server.address().port;
    const gw = `http://127.0.0.1:${port}`;

    const out = await runAsync(process.execPath, [
      cli, 'delegate', '--to', 'dry_run', '--briefing-workspace', 'team-qa', '--gateway-url', gw,
      '--format', 'json', 'What is the enrollment blocker?',
    ], {
      AGENTCTL_HOME: home,
      AGENTCTL_GATEWAY_URL: gw,
    }, 30_000);
    const line = out.trim().split('\n').pop() ?? '';
    const env = JSON.parse(line);
    if (!env.ok) throw new Error(env.error ?? 'delegate failed');
    ok('delegate dry_run + gateway JIT', `agent=${env.result?.route?.agent ?? 'dry_run'}`);

    await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function qaVitest() {
  run('npm', ['test'], {});
  ok('npm test', 'full suite');
}

async function main() {
  console.log('=== agentctl qa-full ===\n');
  try {
    run('npm', ['run', 'build'], {});
    ok('npm run build');

    await qaVitest();
    await runSmoke();
    await qaDelegateGateway();

    const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
    if (dockerOk) {
      await qaPostgres();
    } else {
      ok('Postgres Docker QA', 'skipped (no docker)');
    }

    const failed = log.filter((e) => !e.pass);
    console.log(`\n=== QA-full: ${log.length - failed.length}/${log.length} passed ===`);
    if (failed.length) process.exit(1);
  } catch (e) {
    bad('QA-full', e instanceof Error ? e.message : String(e));
    console.log(`\n=== QA-full: ${log.filter((x) => x.pass).length}/${log.length} passed (aborted) ===`);
    process.exit(1);
  }
}

main();
