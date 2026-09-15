import type {
  AgentReport,
  AgentSignal,
  AgentState,
  ByteBreakdown,
  NettopCollection,
  PsCollection,
  PsProcess,
  SessionCollection,
  ProbeCollection,
  AgentProcessReport
} from "./types.js";
import type { StaticSignalsResult } from "./collectors/static.js";

export const ACTIVITY_MIN_TOTAL_BYTES = 1024;
export const ACTIVITY_MIN_INTERVAL_BYTES = 128;
export const ACTIVITY_MIN_ACTIVE_INTERVALS = 2;

export interface CorrelationInput {
  registry: AgentSignal[];
  ps: PsCollection;
  nettop: NettopCollection;
  staticSignals: StaticSignalsResult;
  sessions: SessionCollection;
  probes: ProbeCollection;
}

function patternMatches(pattern: RegExp, value: string): boolean {
  // Registry expressions are data and may be supplied with the global flag.
  // Resetting lastIndex makes matching deterministic across processes.
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function processSearchValues(process: PsProcess): string[] {
  return [process.path, process.args, `${process.path} ${process.args}`];
}

export function matchesAgentProcess(
  signal: AgentSignal,
  process: PsProcess
): boolean {
  const values = processSearchValues(process);
  const excluded = (signal.excludePatterns ?? []).some((pattern) =>
    values.some((value) => patternMatches(pattern, value))
  );
  if (excluded) {
    return false;
  }

  return signal.binaryPatterns.some((pattern) =>
    values.some((value) => patternMatches(pattern, value))
  );
}

/** Used before probing so lsof ports can be joined by process PID. */
export function matchAgentProcesses(
  registry: AgentSignal[],
  processes: PsProcess[]
): Map<string, PsProcess[]> {
  const matches = new Map<string, PsProcess[]>();
  for (const signal of registry) {
    matches.set(
      signal.id,
      processes.filter((process) => matchesAgentProcess(signal, process))
    );
  }
  return matches;
}

function descendantsByPid(processes: PsProcess[]): Map<number, PsProcess[]> {
  const children = new Map<number, PsProcess[]>();
  for (const process of processes) {
    const siblings = children.get(process.ppid) ?? [];
    siblings.push(process);
    children.set(process.ppid, siblings);
  }
  return children;
}

function collectDescendants(
  rootPid: number,
  children: Map<number, PsProcess[]>
): PsProcess[] {
  const descendants: PsProcess[] = [];
  const visited = new Set<number>([rootPid]);
  const pending = [...(children.get(rootPid) ?? [])];

  while (pending.length > 0) {
    const process = pending.shift();
    if (!process || visited.has(process.pid)) {
      continue;
    }
    visited.add(process.pid);
    descendants.push(process);
    pending.push(...(children.get(process.pid) ?? []));
  }

  return descendants;
}

function hasMatchedAncestor(
  process: PsProcess,
  matchedPids: Set<number>,
  processesByPid: Map<number, PsProcess>
): boolean {
  const visited = new Set<number>();
  let parentPid = process.ppid;
  while (parentPid > 0 && !visited.has(parentPid)) {
    if (matchedPids.has(parentPid)) {
      return true;
    }
    visited.add(parentPid);
    parentPid = processesByPid.get(parentPid)?.ppid ?? 0;
  }
  return false;
}

function zeroBytes(): ByteBreakdown {
  return {
    bytesInExternal: 0,
    bytesOutExternal: 0,
    bytesInLoopback: 0,
    bytesOutLoopback: 0
  };
}

function addBytes(target: ByteBreakdown, source: ByteBreakdown): void {
  target.bytesInExternal += source.bytesInExternal;
  target.bytesOutExternal += source.bytesOutExternal;
  target.bytesInLoopback += source.bytesInLoopback;
  target.bytesOutLoopback += source.bytesOutLoopback;
}

function processReport(
  process: PsProcess,
  children: number
): AgentProcessReport {
  return {
    pid: process.pid,
    ppid: process.ppid,
    path: process.path,
    etime: process.etime,
    children
  };
}

function asIsoTime(milliseconds: number | null): string | null {
  if (milliseconds === null || !Number.isFinite(milliseconds)) {
    return null;
  }
  return new Date(milliseconds).toISOString();
}

function sumForRoot(
  root: PsProcess,
  descendants: PsProcess[],
  nettop: NettopCollection
): ByteBreakdown {
  const bytes = zeroBytes();
  for (const process of [root, ...descendants]) {
    const sample = nettop.byPid.get(process.pid);
    if (sample) {
      addBytes(bytes, sample);
    }
  }
  return bytes;
}

function aggregateAgent(
  matchedProcesses: PsProcess[],
  allProcesses: PsProcess[],
  nettop: NettopCollection
): { processes: AgentProcessReport[]; bytes: ByteBreakdown; intervalBytes: number[] } {
  const processesByPid = new Map(allProcesses.map((process) => [process.pid, process]));
  const children = descendantsByPid(allProcesses);
  const matchedPids = new Set(matchedProcesses.map((process) => process.pid));
  const roots = matchedProcesses
    .filter((process) => !hasMatchedAncestor(process, matchedPids, processesByPid))
    .sort((left, right) => left.pid - right.pid);

  const groups = new Map<string, { root: PsProcess; members: PsProcess[] }>();
  for (const root of roots) {
    const bundle = root.path.match(/^(.+?\.app)(?:\/|$)/i)?.[1];
    const key = bundle ? `bundle:${bundle.toLowerCase()}` : `pid:${root.pid}`;
    const members = [root, ...collectDescendants(root.pid, children)];
    const group = groups.get(key);
    if (group) {
      group.members.push(...members);
      if (/chrome_crashpad_handler| Helper(?: \(|$)|\/Updater\.app\//i.test(group.root.path)) {
        group.root = root;
      }
    } else {
      groups.set(key, { root, members });
    }
  }

  const bytes = zeroBytes();
  const intervalBytes: number[] = [];
  const reports: AgentProcessReport[] = [];
  for (const group of groups.values()) {
    const uniqueMembers = [...new Map(group.members.map((process) => [process.pid, process])).values()];
    addBytes(
      bytes,
      sumForRoot(
        group.root,
        uniqueMembers.filter((process) => process.pid !== group.root.pid),
        nettop
      )
    );
    for (const process of uniqueMembers) {
      const sampleIntervals = nettop.intervalBytesByPid.get(process.pid) ?? [];
      sampleIntervals.forEach((value, index) => {
        intervalBytes[index] = (intervalBytes[index] ?? 0) + value;
      });
    }
    reports.push(processReport(group.root, uniqueMembers.length - 1));
  }

  return { processes: reports, bytes, intervalBytes };
}

export function hasMeaningfulNetworkActivity(intervalBytes: number[]): boolean {
  const total = intervalBytes.reduce((sum, value) => sum + value, 0);
  const activeIntervals = intervalBytes.filter(
    (value) => value >= ACTIVITY_MIN_INTERVAL_BYTES
  ).length;
  return (
    total >= ACTIVITY_MIN_TOTAL_BYTES ||
    activeIntervals >= ACTIVITY_MIN_ACTIVE_INTERVALS
  );
}

function liveState(signalCount: number): AgentState {
  if (signalCount === 0) {
    return "absent";
  }
  if (signalCount === 1) {
    return "suspected";
  }
  return "confirmed";
}

export function correlateAgents(input: CorrelationInput): AgentReport[] {
  const {
    registry,
    ps,
    nettop,
    staticSignals,
    sessions,
    probes
  } = input;
  const allProcesses = ps.processes;
  const matches = matchAgentProcesses(registry, allProcesses);

  return registry.map((signal) => {
    const matchedProcesses = matches.get(signal.id) ?? [];
    const aggregate = aggregateAgent(matchedProcesses, allProcesses, nettop);
    const session = sessions.byAgent.get(signal.id);
    const probe = probes.byAgent.get(signal.id);
    const staticEvidence = staticSignals.byAgent.get(signal.id) ?? [];
    const recentSession = session?.recent === true;
    const networkActivityEnabled = signal.networkActivity !== false;
    const byteDelta =
      networkActivityEnabled &&
      nettop.sampling === "delta" &&
      hasMeaningfulNetworkActivity(aggregate.intervalBytes);
    const reportedBytes = networkActivityEnabled ? aggregate.bytes : zeroBytes();
    const liveSignals: string[] = [];

    if (matchedProcesses.length > 0) {
      liveSignals.push("process");
    }
    if (byteDelta) {
      liveSignals.push("bytes");
    }
    if (recentSession) {
      liveSignals.push("session");
    }

    let state: AgentState;
    const psFailed = ps.status !== "ok";
    const nettopAffectsAgent =
      networkActivityEnabled && nettop.status !== "ok" && matchedProcesses.length > 0;
    const sessionFailed = session?.status === "failed";
    if (psFailed || nettopAffectsAgent || sessionFailed) {
      // A failed required collector must remain visible as unknown. In
      // particular, an empty process list after ps failure is not absence.
      state = "unknown";
    } else {
      state = liveState(liveSignals.length);
    }

    const activity = matchedProcesses.length === 0
      ? "absent"
      : byteDelta || recentSession
        ? "active"
        : "idle";

    return {
      id: signal.id,
      label: signal.label,
      kind: signal.kind,
      state,
      activity,
      live_signals: liveSignals,
      static_signals: staticEvidence,
      processes: aggregate.processes,
      bytes_out_external: reportedBytes.bytesOutExternal,
      bytes_in_external: reportedBytes.bytesInExternal,
      bytes_out_loopback: reportedBytes.bytesOutLoopback,
      bytes_in_loopback: reportedBytes.bytesInLoopback,
      last_session_write: asIsoTime(session?.lastWriteMs ?? null),
      models: probe?.models ?? []
    };
  });
}
