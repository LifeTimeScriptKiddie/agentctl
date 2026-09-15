import { platform, userInfo } from "node:os";
import { collectListeners } from "./collectors/listeners.js";
import { collectNettop } from "./collectors/nettop.js";
import { collectProbes } from "./collectors/probes.js";
import { collectPs } from "./collectors/ps.js";
import { collectSessions } from "./collectors/sessions.js";
import { collectStaticSignals } from "./collectors/static.js";
import { correlateAgents, matchAgentProcesses } from "./correlate.js";
import { SIGNALS } from "./registry.js";
import type { AgentwatchOutput, PsProcess } from "./types.js";

function uid(): number {
  const currentUid = process.getuid?.();
  return currentUid ?? userInfo().uid;
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const port = Number.parseInt(value, 10);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535
    ? port
    : undefined;
}

function configuredPortOverrides(): Map<string, number> {
  const overrides = new Map<string, number>();
  const ollama = parsePort(process.env.AGENTCTL_MONITOR_OLLAMA_PORT ?? process.env.AGENTWATCH_OLLAMA_PORT);
  const lmstudio = parsePort(process.env.AGENTCTL_MONITOR_LMSTUDIO_PORT ?? process.env.AGENTWATCH_LMSTUDIO_PORT);
  if (ollama !== undefined) {
    overrides.set("ollama", ollama);
  }
  if (lmstudio !== undefined) {
    overrides.set("lmstudio", lmstudio);
  }
  return overrides;
}

function portsByAgent(
  matches: Map<string, PsProcess[]>,
  listenerPorts: Map<number, number[]>,
  allProcesses: PsProcess[]
): Map<string, number[]> {
  const children = new Map<number, PsProcess[]>();
  for (const process of allProcesses) {
    const siblings = children.get(process.ppid) ?? [];
    siblings.push(process);
    children.set(process.ppid, siblings);
  }

  const result = new Map<string, number[]>();
  for (const [agentId, processes] of matches) {
    const ports = new Set<number>();
    const pending = [...processes];
    const visited = new Set<number>();
    while (pending.length > 0) {
      const process = pending.shift();
      if (!process || visited.has(process.pid)) {
        continue;
      }
      visited.add(process.pid);
      for (const port of listenerPorts.get(process.pid) ?? []) {
        ports.add(port);
      }
      pending.push(...(children.get(process.pid) ?? []));
    }
    result.set(agentId, [...ports].sort((left, right) => left - right));
  }
  return result;
}

export async function collectOutput(hostPlatform: NodeJS.Platform = platform()): Promise<AgentwatchOutput> {
  if (hostPlatform !== "darwin") {
    throw new Error("agentctl monitor requires macOS (darwin)");
  }

  const currentUid = uid();
  const nowMs = Date.now();
  const [ps, nettop, listeners, staticSignals, sessions] = await Promise.all([
    collectPs(currentUid),
    collectNettop(),
    collectListeners(currentUid),
    collectStaticSignals(SIGNALS),
    collectSessions(SIGNALS, nowMs)
  ]);

  const matches = matchAgentProcesses(SIGNALS, ps.processes);
  const probes = await collectProbes(SIGNALS, {
    portsByAgent: portsByAgent(matches, listeners.portsByPid, ps.processes),
    portOverrides: configuredPortOverrides(),
    timeoutMs: 1000
  });

  const warnings = [
    ...staticSignals.warnings,
    ...sessions.warnings,
    ...probes.warnings
  ];
  if (listeners.error) {
    warnings.push(`listeners: ${listeners.error}`);
  }
  if (ps.error) {
    warnings.push(`ps: ${ps.error}`);
  }
  if (nettop.error) {
    warnings.push(`nettop: ${nettop.error}`);
  }


  return {
    schema: 1,
    generated_at: new Date().toISOString(),
    host: {
      platform: platform(),
      uid: currentUid,
      scoped_to_uid: true
    },
    sampling: nettop.sampling,
    sample_window_ms: nettop.sampleWindowMs,
    collectors: {
      ps: ps.status,
      nettop: nettop.status,
      probes: probes.status
    },
    agents: correlateAgents({ registry: SIGNALS, ps, nettop, staticSignals, sessions, probes }),
    warnings
  };
}

