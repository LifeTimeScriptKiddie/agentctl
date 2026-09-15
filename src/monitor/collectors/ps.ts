import { run } from "../../util/exec.js";
import type { PsCollection, PsProcess } from "../types.js";

export type CommandRunner = (command: string, args: string[]) => Promise<string>;

export const defaultCommandRunner: CommandRunner = async (command, args) => {
  const result = await run(command, args, { timeoutMs: 10_000 });
  // Never include command stdout/stderr: ps args can contain prompts or secrets.
  if (result.failed) throw new Error(`${command} unavailable (exit ${result.exitCode})`);
  return result.stdout;
};

function parsePositiveInteger(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Parse the no-header comm form emitted by macOS ps. */
export function parsePsComm(output: string): Map<number, PsProcess> {
  const processes = new Map<number, PsProcess>();

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }

    const pid = parsePositiveInteger(match[1]!);
    const ppid = parsePositiveInteger(match[2]!);
    if (pid === null || ppid === null) {
      continue;
    }

    processes.set(pid, {
      pid,
      ppid,
      etime: match[3]!,
      cputime: match[4]!,
      path: match[5]!,
      args: ""
    });
  }

  return processes;
}

/** Parse the no-header pid,args form emitted by macOS ps. */
export function parsePsArgs(output: string): Map<number, string> {
  const argsByPid = new Map<number, string>();

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const match = line.match(/^\s*(\d+)(?:\s+(.*?))?\s*$/);
    if (!match) {
      continue;
    }

    const pid = parsePositiveInteger(match[1]!);
    if (pid !== null) {
      argsByPid.set(pid, match[2]! ?? "");
    }
  }

  return argsByPid;
}

export function mergePsOutputs(commOutput: string, argsOutput: string): PsProcess[] {
  const processes = parsePsComm(commOutput);
  const argsByPid = parsePsArgs(argsOutput);

  for (const [pid, args] of argsByPid) {
    const process = processes.get(pid);
    if (process) {
      process.args = args;
    }
  }

  return [...processes.values()].sort((left, right) => left.pid - right.pid);
}

export async function collectPs(
  uid: number,
  run: CommandRunner = defaultCommandRunner
): Promise<PsCollection> {
  const commArgs = [
    "-U",
    String(uid),
    "-ww",
    "-o",
    "pid=,ppid=,etime=,cputime=,comm="
  ];
  const argsArgs = ["-U", String(uid), "-ww", "-o", "pid=,args="];

  const [commResult, argsResult] = await Promise.allSettled([
    run("ps", commArgs),
    run("ps", argsArgs)
  ]);

  if (commResult.status === "rejected" || argsResult.status === "rejected") {
    const messages: string[] = [];
    if (commResult.status === "rejected") {
      messages.push(`comm: ${String(commResult.reason)}`);
    }
    if (argsResult.status === "rejected") {
      messages.push(`args: ${String(argsResult.reason)}`);
    }
    return {
      status: "failed",
      processes: [],
      error: messages.join("; ")
    };
  }

  return {
    status: "ok",
    processes: mergePsOutputs(commResult.value, argsResult.value)
  };
}
