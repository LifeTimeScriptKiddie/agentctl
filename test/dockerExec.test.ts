import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DockerExecAdapter, buildExecArgs } from '../src/adapters/dockerExec.js';
import { loadPreset } from '../src/assets.js';
import { PresetSchema } from '../src/schema/agents.js';
import type { AdapterRequest } from '../src/schema/index.js';
import * as exec from '../src/util/exec.js';

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));
const runMock = vi.mocked(exec.run);

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', timedOut: false, failed: false });

function req(prompt = 'hi'): AdapterRequest {
  return {
    role: 'chat', prompt, outputContract: 'text', contextPaths: [],
    timeoutSeconds: 300, maxTurns: 1, allowedTools: [], workdir: null,
  };
}

/** Route a `docker ps` mock by which --filter is present. */
function psRouter(byName: string, byImage: string) {
  return (file: unknown, args?: string[]) => {
    const a = args ?? [];
    if (file === 'docker' && a.includes('ps')) {
      const isName = a.some((x) => x.startsWith('name='));
      return Promise.resolve(ok(isName ? byName : byImage));
    }
    return Promise.resolve(ok('hermes says hi')); // docker exec
  };
}

beforeEach(() => runMock.mockReset());

describe('container resolution', () => {
  it('prefers the persistent gateway by name', async () => {
    runMock.mockImplementation(psRouter('hermes-gateway-local', ''));
    const a = new DockerExecAdapter(loadPreset('hermes'));
    expect(await a.resolveContainer()).toBe('hermes-gateway-local');
  });

  it('falls back by image but rejects the AutoRemove transient sibling', async () => {
    // gateway absent; image has a transient cli-run plus a persistent sibling
    runMock.mockImplementation(psRouter('', 'hermes-agent-cli-run-deadbeef\nhermes-gw-2'));
    const a = new DockerExecAdapter(loadPreset('hermes'));
    expect(await a.resolveContainer()).toBe('hermes-gw-2');
  });

  it('errors (transport) when only a transient container exists', async () => {
    runMock.mockImplementation(psRouter('', 'hermes-agent-cli-run-deadbeef'));
    const a = new DockerExecAdapter(loadPreset('hermes'));
    const r = await a.invoke(req());
    expect(r.ok).toBe(false);
    expect(r.failureClass).toBe('transport_error');
  });
});

describe('buildExecArgs', () => {
  it('omits -t when no toolset is pinned', () => {
    expect(buildExecArgs(loadPreset('hermes'), 'hermes-gateway-local', req('p'))).toEqual([
      'exec', 'hermes-gateway-local', 'hermes', '-z', 'p',
    ]);
  });
  it('adds -t when a toolset is pinned', () => {
    const preset = PresetSchema.parse({ ...loadPreset('hermes'), toolsets: 'file,web' });
    expect(buildExecArgs(preset, 'hermes-gateway-local', req('p'))).toEqual([
      'exec', 'hermes-gateway-local', 'hermes', '-z', 'p', '-t', 'file,web',
    ]);
  });
});

describe('invoke', () => {
  it('returns hermes text on success', async () => {
    runMock.mockImplementation(psRouter('hermes-gateway-local', ''));
    const a = new DockerExecAdapter(loadPreset('hermes'));
    const r = await a.invoke(req());
    expect(r.ok).toBe(true);
    expect(r.normalizedText).toBe('hermes says hi');
  });

  it('maps a non-zero docker exec to nonzero_exit', async () => {
    runMock.mockImplementation((_file: unknown, args?: string[]) => {
      const a = args ?? [];
      if (a.includes('ps')) return Promise.resolve(ok('hermes-gateway-local'));
      return Promise.resolve({ exitCode: 2, stdout: '', stderr: 'err', timedOut: false, failed: true });
    });
    const a = new DockerExecAdapter(loadPreset('hermes'));
    expect((await a.invoke(req())).failureClass).toBe('nonzero_exit');
  });
});
