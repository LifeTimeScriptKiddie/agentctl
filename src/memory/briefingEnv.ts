/** Default team workspace for JIT briefing when CLI/Pi omit `--briefing-workspace`. */
export function resolveBriefingWorkspace(explicit?: string): string | undefined {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  const env = process.env.AGENTCTL_BRIEFING_WORKSPACE?.trim();
  return env || undefined;
}

/** Prepend `--briefing-workspace` from env when absent (Pi / scripted argv). */
export function applyWorkerBriefingArgv(argv: string[]): string[] {
  if (argv.some((a, i) => a === '--briefing-workspace' && argv[i + 1])) return argv;
  const ws = resolveBriefingWorkspace();
  if (!ws) return argv;
  return ['--briefing-workspace', ws, ...argv];
}

/** Default workspace for memory operator commands (review queue, etc.). */
export function defaultMemoryWorkspace(explicit?: string): string {
  return resolveBriefingWorkspace(explicit) ?? 'agentctl-pilot';
}
