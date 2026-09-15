import { mkdir, rename, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import type { AgentwatchOutput } from './types.js';

export type Collector = () => Promise<AgentwatchOutput>;

/** Replace a complete snapshot without chmod'ing an existing user directory. */
export async function writeFeedAtomic(path: string, output: AgentwatchOutput): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(`${JSON.stringify(output)}\n`, 'utf8'); }
    finally { await file.close(); }
    await rename(temporary, path);
  } catch (error) {
    // Leave no stale snapshot beside the feed; report the original failure.
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function runSamples(
  intervalMs: number, collect: Collector,
  consume: (output: AgentwatchOutput) => void | Promise<void>, signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const started = Date.now();
    const output = await collect();
    if (signal.aborted) break;
    await consume(output);
    if (signal.aborted) break;
    try { await setTimeout(Math.max(1, intervalMs - (Date.now() - started)), undefined, { signal }); }
    catch (error) { if (!signal.aborted) throw error; }
  }
}

export async function runFeed(path: string, intervalMs: number, collect: Collector, signal: AbortSignal): Promise<void> {
  await runSamples(intervalMs, collect, (output) => writeFeedAtomic(path, output), signal);
}
