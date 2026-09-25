/** Optional one-shot Laya load at memory-serve startup (reduces first-request latency). */
export async function warmLayaIfConfigured(): Promise<{ warmed: boolean; detail?: string }> {
  if (process.env.AGENTCTL_LAYA_WARM === '0') {
    return { warmed: false, detail: 'AGENTCTL_LAYA_WARM=0' };
  }
  const evidenceOn =
    process.env.AGENTCTL_LAYA_EVIDENCE === '1' || process.env.AGENTCTL_LAYA_EVIDENCE === 'true';
  const { loadLayaConfig, selectEvidence } = await import('./layaEvidence.js');
  const cfg = loadLayaConfig();
  if (!cfg.enabled && !evidenceOn) {
    return { warmed: false, detail: 'laya not enabled' };
  }
  try {
    await selectEvidence(
      'memory serve warmup probe',
      [
        { id: 'warmup-a', text: 'Warmup probe: permitted evidence may be cited.' },
        { id: 'warmup-b', text: 'Unrelated noise for contrast during serve startup.' },
      ],
      { ...cfg, enabled: true },
    );
    return { warmed: true };
  } catch (e) {
    return {
      warmed: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
