import * as fs from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentSignal,
  SessionAgentResult,
  SessionCollection
} from "../types.js";

export const SESSION_RECENCY_MS = 30_000;

/**
 * The session collector intentionally exposes only stat/readdir operations.
 * There is no readFile, open, tail, or stream operation here: session bodies
 * contain prompts and source code and are outside agentwatch's privacy scope.
 */
export interface SessionFs {
  readdir(
    path: string
  ): Promise<Array<{
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }>>;
  stat(path: string): Promise<{
    isDirectory(): boolean;
    isFile(): boolean;
    mtimeMs: number;
  }>;
}

const defaultSessionFs: SessionFs = {
  readdir: async (path) =>
    fs.readdir(path, { withFileTypes: true }) as unknown as Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }>,
  stat: (path) => fs.stat(path)
};

interface ScanResult {
  lastWriteMs: number | null;
}

function globRoot(glob: string): string {
  const recursiveMarker = glob.indexOf("/**");
  return recursiveMarker >= 0 ? glob.slice(0, recursiveMarker) : glob;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function scanGlob(
  glob: string,
  sessionFs: SessionFs
): Promise<ScanResult> {
  const root = globRoot(glob);
  let lastWriteMs: number | null = null;
  let visited = 0;
  const deadline = Date.now() + 1500;

  async function walk(directory: string, isRoot: boolean): Promise<void> {
    let directoryStat: Awaited<ReturnType<SessionFs["stat"]>>;
    try {
      // Stat the parent before opening it. Besides making the common case
      // cheap, this keeps missing optional session roots non-fatal.
      directoryStat = await sessionFs.stat(directory);
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw error;
    }

    if (!directoryStat.isDirectory()) {
      return;
    }

    let entries: Awaited<ReturnType<SessionFs["readdir"]>>;
    try {
      entries = await sessionFs.readdir(directory);
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (++visited > 50_000 || Date.now() > deadline) throw new Error("metadata scan budget exceeded");
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(child, false);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      let fileStat: Awaited<ReturnType<SessionFs["stat"]>>;
      try {
        // This is the only information collected from a session file.
        fileStat = await sessionFs.stat(child);
      } catch (error) {
        if (isMissing(error)) {
          continue;
        }
        throw error;
      }

      if (!fileStat.isFile()) {
        continue;
      }

      if (lastWriteMs === null || fileStat.mtimeMs > lastWriteMs) {
        lastWriteMs = fileStat.mtimeMs;
      }
    }
  }

  await walk(root, true);
  return { lastWriteMs };
}

function resultFromScan(
  scan: ScanResult,
  nowMs: number
): SessionAgentResult {
  const lastWriteMs = scan.lastWriteMs;
  return {
    status: lastWriteMs === null ? "missing" : "ok",
    lastWriteMs,
    recent: lastWriteMs !== null && nowMs >= lastWriteMs && nowMs - lastWriteMs <= SESSION_RECENCY_MS
  };
}

export async function collectSessions(
  registry: AgentSignal[],
  nowMs = Date.now(),
  sessionFs: SessionFs = defaultSessionFs
): Promise<SessionCollection> {
  const byAgent = new Map<string, SessionAgentResult>();
  const warnings: string[] = [];

  for (const signal of registry) {
    const globs = signal.sessionGlobs ?? [];
    if (globs.length === 0) {
      byAgent.set(signal.id, {
        status: "missing",
        lastWriteMs: null,
        recent: false
      });
      continue;
    }

    let lastWriteMs: number | null = null;
    let failed = false;

    for (const glob of globs) {
      try {
        const scan = await scanGlob(glob, sessionFs);
        if (
          scan.lastWriteMs !== null &&
          (lastWriteMs === null || scan.lastWriteMs > lastWriteMs)
        ) {
          lastWriteMs = scan.lastWriteMs;
        }
      } catch (error) {
        failed = true;
        warnings.push(`${signal.id} session scan failed: ${String(error)}`);
      }
    }

    if (failed) {
      byAgent.set(signal.id, {
        status: "failed",
        lastWriteMs,
        recent: lastWriteMs !== null && nowMs >= lastWriteMs && nowMs - lastWriteMs <= SESSION_RECENCY_MS
      });
      continue;
    }

    byAgent.set(
      signal.id,
      resultFromScan({ lastWriteMs }, nowMs)
    );
  }

  return { byAgent, warnings };
}
