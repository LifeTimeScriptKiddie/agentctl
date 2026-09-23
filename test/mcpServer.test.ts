import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as exec from '../src/util/exec.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { createAgentctlMcpServer, type McpServerOptions } from '../src/mcp/server.js';
import { runJob } from '../src/jobs/runner.js';

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));
const runMock = vi.mocked(exec.run);

beforeEach(() => {
  vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-mcp-')));
  runMock.mockReset();
  runMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false });
});
afterEach(() => vi.unstubAllEnvs());

async function connect(opts: McpServerOptions = {}) {
  const registry = AdapterRegistry.fromPackaged();
  // Run jobs in-process instead of a detached child so tests stay hermetic.
  const launch = (id: string) => {
    void runJob(id, { registry });
    return null;
  };
  const server = createAgentctlMcpServer({ registry, launch, maxWaitSeconds: 5, ...opts });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe('agentctl MCP server', () => {
  it('lists the orchestrator tools, without approval fields unless the operator allows them', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'agentctl_agents', 'agentctl_delegate', 'agentctl_job_cancel', 'agentctl_job_events',
      'agentctl_job_result', 'agentctl_job_status', 'agentctl_job_wait', 'agentctl_jobs_list',
      'agentctl_orchestrate', 'agentctl_route',
    ]);
    const delegate = tools.find((t) => t.name === 'agentctl_delegate')!;
    expect(Object.keys(delegate.inputSchema.properties ?? {})).not.toContain('approve');

    const approving = await connect({ allowApprove: true });
    const d2 = (await approving.listTools()).tools.find((t) => t.name === 'agentctl_delegate')!;
    expect(Object.keys(d2.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['approve', 'approve_context']));
  });

  it('delegates a task and returns the finished result within the wait', async () => {
    const client = await connect();
    const r = payload(await client.callTool({ name: 'agentctl_delegate', arguments: { task: 'say hello', to: 'dry_run', wait_seconds: 5 } }));
    expect(r).toMatchObject({ done: true, status: 'succeeded' });
    expect((r.result as { ask: { agent: string } }).ask.agent).toBe('dry_run');

    const status = payload(await client.callTool({ name: 'agentctl_job_status', arguments: { job_id: r.job_id } }));
    expect(status).toMatchObject({ status: 'succeeded', kind: 'delegate' });
  });

  it('returns a job id immediately for orchestration and lets the client poll it', async () => {
    const client = await connect();
    const r = payload(await client.callTool({ name: 'agentctl_orchestrate', arguments: { goal: 'plan something', dry_plan: true } }));
    expect(r).toMatchObject({ done: false });
    expect(String(r.job_id)).toMatch(/^job_/);
    const waited = payload(await client.callTool({ name: 'agentctl_job_wait', arguments: { job_id: r.job_id, wait_seconds: 5 } }));
    expect(waited.done).toBe(true);
    const events = payload(await client.callTool({ name: 'agentctl_job_events', arguments: { job_id: r.job_id } }));
    expect((events.events as Array<{ type: string }>).map((e) => e.type)[0]).toBe('queued');
  });

  it('refuses destructive requests and ignores a client-sent approve flag without --allow-approve', async () => {
    const client = await connect();
    const r = await client.callTool({
      name: 'agentctl_delegate', arguments: { task: 'git push origin main', to: 'dry_run', approve: true },
    });
    expect(r.isError).toBe(true);
    expect(payload(r).error).toMatch(/destructive\/outward-facing.*git-push/);
  });

  it('keeps the calling agent out of routing and refuses delegating back to it', async () => {
    const client = await connect({ caller: ['cursor'] });
    const back = await client.callTool({ name: 'agentctl_delegate', arguments: { task: 'x', to: 'cursor' } });
    expect(back.isError).toBe(true);
    expect(payload(back).error).toMatch(/calling agent/);

    const routed = payload(await client.callTool({ name: 'agentctl_route', arguments: { task: 'refactor the parser code' } }));
    const ranked = (routed.ranked as Array<{ agent: string }>).map((r) => r.agent);
    expect(ranked).not.toContain('cursor');
    expect(routed.agent).not.toBe('cursor');

    const agents = payload(await client.callTool({ name: 'agentctl_agents', arguments: {} }));
    expect((agents.agents as Array<{ name: string; routable: boolean }>).find((a) => a.name === 'cursor')!.routable).toBe(false);
  });

  it('rejects malformed job ids', async () => {
    const client = await connect();
    const r = await client.callTool({ name: 'agentctl_job_status', arguments: { job_id: '../../etc/passwd' } });
    expect(r.isError).toBe(true);
  });
});
