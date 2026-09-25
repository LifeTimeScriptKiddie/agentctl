import { describe, it, expect, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaMock }));

describe('agentctlCliRunner', () => {
  it('treats lanes without reported capabilities as unknown (fail closed)', async () => {
    const { agentctlCliRunner } = await import('../packages/shared_ptr/src/turnModelGenerate.js');
    // an older agentctl: `agents --format json` lists names and transports only
    execaMock.mockResolvedValue({ exitCode: 0, stdout: JSON.stringify({ ok: true, result: { agents: [
      { name: 'codex_write', transport: 'subprocess' },
      { name: 'dry_run', transport: 'subprocess', capabilities: { canReadFiles: false } },
    ] } }) });
    const runner = agentctlCliRunner();
    expect(await runner.capabilities('codex_write')).toBeNull();
    expect(await runner.capabilities('dry_run')).toEqual({ canReadFiles: false });
    expect(await runner.capabilities('nope')).toBeNull();
  });

  it('an unreadable agents listing leaves every lane unknown', async () => {
    const { agentctlCliRunner } = await import('../packages/shared_ptr/src/turnModelGenerate.js');
    execaMock.mockResolvedValue({ exitCode: 1, stdout: 'not json' });
    expect(await agentctlCliRunner().capabilities('dry_run')).toBeNull();
  });
});
