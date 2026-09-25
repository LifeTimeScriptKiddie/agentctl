/**
 * Process role. The benchmark replays candidate graphs by changing process-wide
 * settings, which must never happen inside a process that serves real searches.
 */
let serving = false;

export function markServing(): void {
  serving = true;
}

export function isServing(): boolean {
  return serving;
}
