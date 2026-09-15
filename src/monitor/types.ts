export type AgentKind = "cloud" | "local" | "hybrid";
export type AgentState = "absent" | "suspected" | "confirmed" | "unknown";
export type ActivityState = "absent" | "idle" | "active";
export type CollectorStatus = "ok" | "partial" | "failed";
export type SamplingMode = "delta" | "cumulative";

export interface LocalProbe {
  defaultPort: number;
  path: string;
}

export interface AgentSignal {
  id: string;
  label: string;
  kind: AgentKind;
  binaryPatterns: RegExp[];
  excludePatterns?: RegExp[];
  configDirs: string[];
  staticPaths?: string[];
  sessionGlobs?: string[];
  localProbe?: LocalProbe;
  /** False for browser-shaped apps whose traffic cannot identify AI activity. */
  networkActivity?: boolean;
}

export interface PsProcess {
  pid: number;
  ppid: number;
  etime: string;
  cputime: string;
  path: string;
  args: string;
}

export interface PsCollection {
  status: "ok" | "failed";
  processes: PsProcess[];
  error?: string;
}

export interface ByteBreakdown {
  bytesInExternal: number;
  bytesOutExternal: number;
  bytesInLoopback: number;
  bytesOutLoopback: number;
}

export interface NettopPidSample extends ByteBreakdown {
  pid: number;
  bytesInTotal: number;
  bytesOutTotal: number;
}

export interface NettopCollection {
  status: "ok" | "failed";
  sampling: SamplingMode;
  sampleWindowMs: number;
  sampleCount: number;
  byPid: Map<number, NettopPidSample>;
  /** Classified traffic observed per PID in each one-second delta interval. */
  intervalBytesByPid: Map<number, number[]>;
  error?: string;
}

export interface ListenerCollection {
  status: "ok" | "failed";
  portsByPid: Map<number, number[]>;
  error?: string;
}

export interface SessionAgentResult {
  status: "ok" | "missing" | "failed";
  lastWriteMs: number | null;
  recent: boolean;
}

export interface SessionCollection {
  byAgent: Map<string, SessionAgentResult>;
  warnings: string[];
}

export interface ModelInfo {
  name: string;
  state?: string;
}

export interface ProbeAgentResult {
  status: "ok" | "failed";
  reachable: boolean;
  models: ModelInfo[];
  warnings: string[];
}

export interface ProbeCollection {
  status: CollectorStatus;
  byAgent: Map<string, ProbeAgentResult>;
  warnings: string[];
}

export interface AgentProcessReport {
  pid: number;
  ppid: number;
  path: string;
  etime: string;
  children: number;
}

export interface AgentReport {
  id: string;
  label: string;
  kind: AgentKind;
  state: AgentState;
  activity: ActivityState;
  live_signals: string[];
  static_signals: string[];
  processes: AgentProcessReport[];
  bytes_out_external: number;
  bytes_in_external: number;
  bytes_out_loopback: number;
  bytes_in_loopback: number;
  last_session_write: string | null;
  models: ModelInfo[];
  /** Cooperative owned-agent state, absent for heuristic-only rows. */
  reported_state?: string;
  /** Explicit controls advertised by the PID-bound owned agent. */
  control_capabilities?: string[];
}

export interface AgentwatchOutput {
  schema: 1;
  generated_at: string;
  host: {
    platform: NodeJS.Platform;
    uid: number;
    scoped_to_uid: true;
  };
  sampling: SamplingMode;
  sample_window_ms: number;
  collectors: {
    ps: CollectorStatus;
    nettop: CollectorStatus;
    probes: CollectorStatus;
  };
  agents: AgentReport[];
  warnings: string[];
}
