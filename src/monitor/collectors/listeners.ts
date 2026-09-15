import type { ListenerCollection } from "../types.js";
import {
  defaultCommandRunner,
  type CommandRunner
} from "./ps.js";

/**
 * Parse lsof by PID and NAME. COMMAND is intentionally ignored: on macOS it
 * can be derived from a versioned install path and is not a stable identity.
 */
export function parseListeners(output: string): Map<number, number[]> {
  const portsByPid = new Map<number, Set<number>>();

  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2 || !/^\d+$/.test(fields[1]!)) {
      continue;
    }

    const pid = Number.parseInt(fields[1]!, 10);
    const portMatch = line.match(/:(\d+)\s+\(LISTEN\)\s*$/);
    if (!Number.isSafeInteger(pid) || !portMatch) {
      continue;
    }

    const port = Number.parseInt(portMatch[1]!, 10);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      continue;
    }

    const ports = portsByPid.get(pid) ?? new Set<number>();
    ports.add(port);
    portsByPid.set(pid, ports);
  }

  return new Map(
    [...portsByPid.entries()].map(([pid, ports]) => [pid, [...ports].sort((a, b) => a - b)])
  );
}

export async function collectListeners(
  uid: number,
  run: CommandRunner = defaultCommandRunner
): Promise<ListenerCollection> {
  try {
    const output = await run("lsof", [
      "-nP",
      "-w",
      "-a",
      "-u",
      String(uid),
      "-iTCP",
      "-sTCP:LISTEN"
    ]);
    return {
      status: "ok",
      portsByPid: parseListeners(output)
    };
  } catch (error) {
    return {
      status: "failed",
      portsByPid: new Map(),
      error: String(error)
    };
  }
}
