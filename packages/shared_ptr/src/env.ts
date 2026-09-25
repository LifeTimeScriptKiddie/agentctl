/**
 * shared_ptr settings: SHARED_PTR_<NAME>, else the legacy AGENTCTL_<NAME>
 * (every existing deployment keeps working through the split).
 */
export function setting(name: string): string | undefined {
  return process.env[`SHARED_PTR_${name}`] ?? process.env[`AGENTCTL_${name}`];
}

/** Set a setting for this process (both names, so older readers agree). */
export function setEnv(name: string, value: string): void {
  process.env[`SHARED_PTR_${name}`] = value;
  process.env[`AGENTCTL_${name}`] = value;
}
