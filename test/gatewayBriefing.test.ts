import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkerPrompt } from '../src/memory/briefingPrompt.js';
import {
  formatGatewayTurnPrefix,
  postTurn,
  resolveGatewayUrl,
} from '../src/memory/gatewayClient.js';

describe('gateway briefing client', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('resolveGatewayUrl strips trailing slash and reads env', () => {
    vi.stubEnv('AGENTCTL_GATEWAY_URL', 'http://127.0.0.1:8741/');
    expect(resolveGatewayUrl()).toBe('http://127.0.0.1:8741');
    expect(resolveGatewayUrl('http://override/')).toBe('http://override');
  });

  it('formatGatewayTurnPrefix renders bundle items and checkpoint', () => {
    const prefix = formatGatewayTurnPrefix(
      {
        request_id: 'req-1',
        status: 'context_ready',
        context_bundle: {
          context_bundle_id: 'ctx_1',
          policy_decision_id: 'pdp_1',
          workspace: 'team-atlas',
          query: 'status?',
          evidence_status: 'verified',
          terminal: 'context_ready',
          graph: 'context_retrieval',
          graph_version: 1,
          items: [
            {
              type: 'approved_memory',
              scope: 'workspace:team-atlas',
              content: 'Atlas milestone shipped',
              source_ref: 'operator:2026-09-22',
              memory_id: 'mem_abc',
              revision: 2,
            },
          ],
          checkpoint: {
            workspace: 'team-atlas',
            revision: 1,
            goal: 'Team assistant',
            state: 'green',
            blockers: [],
            nextAction: 'Wire Pi clients',
            decisionRefs: [],
            source: 'operator:t',
          },
          precedence_note: 'test',
        },
        answer: null,
      },
      'team-atlas',
    );
    expect(prefix).toContain('=== Team context');
    expect(prefix).toContain('[mem_abc rev 2] Atlas milestone shipped');
    expect(prefix).toContain('Next action: Wire Pi clients');
  });

  it('buildWorkerPrompt calls POST /v1/turn when gateway env is set', async () => {
    vi.stubEnv('AGENTCTL_GATEWAY_URL', 'http://gw.test');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        request_id: 'r1',
        status: 'context_ready',
        context_bundle: {
          context_bundle_id: 'ctx_1',
          policy_decision_id: 'pdp_1',
          workspace: 'team-atlas',
          query: 'What is next?',
          evidence_status: 'verified',
          terminal: 'context_ready',
          graph: 'context_retrieval',
          graph_version: 1,
          items: [],
          checkpoint: null,
          precedence_note: 'test',
        },
        answer: null,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const prompt = await buildWorkerPrompt({
      agent: 'cursor',
      userPrompt: 'What is next?',
      briefingWorkspace: 'team-atlas',
    });

    expect(prompt.startsWith('=== Team context')).toBe(true);
    expect(prompt.endsWith('What is next?')).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://gw.test/v1/turn',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"workspace":"team-atlas"'),
      }),
    );
  });

  it('uses local briefing when gateway is unset', async () => {
    vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-gw-local-')));
    const { MemoryStore } = await import('../src/memory/store.js');
    const s = await MemoryStore.open();
    s.setCheckpoint({
      workspace: 'pilot',
      revision: 0,
      goal: 'G',
      state: 'S',
      blockers: [],
      nextAction: 'N',
      decisionRefs: [],
      source: 'operator:t',
    });
    s.close();

    const prompt = await buildWorkerPrompt({
      agent: 'cursor',
      userPrompt: 'go',
      briefingWorkspace: 'pilot',
    });
    expect(prompt.startsWith('=== Local resume briefing')).toBe(true);
  });

  it('postTurn surfaces HTTP errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: 'forbidden' }),
      }),
    );
    await expect(
      postTurn('http://gw.test', {
        workspace: 'w',
        query: 'q',
        provider: 'cursor',
        goal: 'q',
      }),
    ).rejects.toThrow('forbidden');
  });
});
