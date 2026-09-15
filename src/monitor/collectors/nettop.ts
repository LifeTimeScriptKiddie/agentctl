import type {
  ByteBreakdown,
  NettopCollection,
  NettopPidSample
} from "../types.js";
import {
  defaultCommandRunner,
  type CommandRunner
} from "./ps.js";

const NETTOP_INTERVAL_MS = 1000;

interface RawConnectionSample {
  loopback: boolean;
  bytesIn: number;
  bytesOut: number;
}

interface RawNettopPidSample extends ByteBreakdown {
  pid: number;
  bytesInTotal: number;
  bytesOutTotal: number;
  connectionRowsWithBytes: number;
  /** Cumulative counters per connection row, keyed by interface and endpoints. */
  connections: Map<string, RawConnectionSample>;
}

type RawSample = Map<number, RawNettopPidSample>;

/** A small CSV parser is enough here and also handles quoted process names. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }

  fields.push(field);
  return fields;
}

function parseCounter(value: string | undefined): number {
  if (!value || !value.trim()) {
    return 0;
  }
  const parsed = Number(value.replaceAll(",", "").trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function processPid(value: string | undefined): number | null {
  // Connection rows are never process rows. IPv6 endpoints are printed as
  // `address.port`, so `tcp6 ::1.1234<->::1.50123` would otherwise parse as
  // process 50123.
  if (!value || value.includes("<->")) {
    return null;
  }
  const match = value.trim().match(/\.(\d+)$/);
  if (!match) {
    return null;
  }
  const pid = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(pid) ? pid : null;
}

function emptyRawSample(pid: number): RawNettopPidSample {
  return {
    pid,
    bytesInTotal: 0,
    bytesOutTotal: 0,
    bytesInExternal: 0,
    bytesOutExternal: 0,
    bytesInLoopback: 0,
    bytesOutLoopback: 0,
    connectionRowsWithBytes: 0,
    connections: new Map()
  };
}

function isLoopbackConnection(connection: string, interfaceName: string): boolean {
  if (interfaceName.trim() === "lo0") {
    return true;
  }

  // The left side is the local endpoint. Only the remote side should make an
  // en0 connection loopback; this matters for a process bound to 127.0.0.1
  // while talking to a non-loopback peer.
  const separator = connection.indexOf("<->");
  const remote = separator >= 0 ? connection.slice(separator + 3) : connection;
  return remote.includes("127.0.0.1") || remote.includes("::1");
}

function isHeader(fields: string[]): boolean {
  return (
    fields[0]?.trim().toLowerCase() === "time" &&
    fields[4]?.trim().toLowerCase() === "bytes_in" &&
    fields[5]?.trim().toLowerCase() === "bytes_out"
  );
}

/**
 * nettop interleaves process rows and connection rows. A process row is the
 * only reliable owner of a connection row; the PID suffix, not the possibly
 * truncated process name, is the join key.
 */
export function parseNettopOutput(output: string): NettopCollection {
  const samples: RawSample[] = [];
  let currentSample: RawSample | null = null;
  let currentPid: number | null = null;
  let currentSampleSecond: string | null = null;
  let sawHeader = false;

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const fields = parseCsvLine(line.replace(/^﻿/, ""));
    if (isHeader(fields)) {
      currentSample = new Map<number, RawNettopPidSample>();
      samples.push(currentSample);
      currentPid = null;
      currentSampleSecond = null;
      sawHeader = true;
      continue;
    }

    if (!currentSample) {
      // Keep the parser useful for a fixture with a stripped header, but mark
      // completely headerless/empty command output as a collector failure.
      currentSample = new Map<number, RawNettopPidSample>();
      samples.push(currentSample);
    }

    const pid = processPid(fields[1]);
    if (pid !== null) {
      const sampleSecond = fields[0]?.trim().split(".")[0] ?? "";
      // Some macOS nettop builds repeat the CSV header for each -L sample;
      // others emit one header and start the next sample with a new timestamp.
      // Process rows are unique within a sample, so either timestamp rollover
      // or a repeated PID is a safe boundary for the target format.
      if (
        currentSample.size > 0 &&
        ((currentSampleSecond !== null &&
          sampleSecond.length > 0 &&
          sampleSecond !== currentSampleSecond) ||
          currentSample.has(pid))
      ) {
        currentSample = new Map<number, RawNettopPidSample>();
        samples.push(currentSample);
        currentPid = null;
        currentSampleSecond = sampleSecond || null;
      } else if (currentSampleSecond === null && sampleSecond.length > 0) {
        currentSampleSecond = sampleSecond;
      }

      const sample = emptyRawSample(pid);
      sample.bytesInTotal = parseCounter(fields[4]);
      sample.bytesOutTotal = parseCounter(fields[5]);
      currentSample.set(pid, sample);
      currentPid = pid;
      continue;
    }

    if (currentPid === null || !fields[1]?.trim()) {
      continue;
    }

    const sample = currentSample.get(currentPid);
    if (!sample) {
      continue;
    }

    const bytesIn = parseCounter(fields[4]);
    const bytesOut = parseCounter(fields[5]);
    if (bytesIn === 0 && bytesOut === 0) {
      // Listen rows commonly have empty counters. They still belong to the
      // current process, but contribute no bytes.
      continue;
    }

    sample.connectionRowsWithBytes += 1;
    const loopback = isLoopbackConnection(fields[1], fields[2] ?? "");
    if (loopback) {
      sample.bytesInLoopback += bytesIn;
      sample.bytesOutLoopback += bytesOut;
    } else {
      sample.bytesInExternal += bytesIn;
      sample.bytesOutExternal += bytesOut;
    }

    const key = `${(fields[2] ?? "").trim()}|${fields[1].trim()}`;
    const connection = sample.connections.get(key) ?? { loopback, bytesIn: 0, bytesOut: 0 };
    connection.bytesIn += bytesIn;
    connection.bytesOut += bytesOut;
    sample.connections.set(key, connection);
  }

  if (!sawHeader || samples.length === 0) {
    return {
      status: "failed",
      sampling: "cumulative",
      sampleWindowMs: NETTOP_INTERVAL_MS,
      sampleCount: 0,
      byPid: new Map(),
      intervalBytesByPid: new Map(),
      error: "nettop output did not contain a recognizable header"
    };
  }

  const normalize = (sample: RawNettopPidSample): NettopPidSample => {
    let bytesInExternal = sample.bytesInExternal;
    let bytesOutExternal = sample.bytesOutExternal;

    // The process row is the aggregate. If nettop omitted an individual
    // connection row, retain the aggregate in the ledger as unclassified
    // external traffic rather than silently dropping bytes.
    const classifiedIn = sample.bytesInExternal + sample.bytesInLoopback;
    const classifiedOut = sample.bytesOutExternal + sample.bytesOutLoopback;
    if (sample.bytesInTotal > classifiedIn) {
      bytesInExternal += sample.bytesInTotal - classifiedIn;
    }
    if (sample.bytesOutTotal > classifiedOut) {
      bytesOutExternal += sample.bytesOutTotal - classifiedOut;
    }

    return {
      pid: sample.pid,
      bytesInTotal: sample.bytesInTotal,
      bytesOutTotal: sample.bytesOutTotal,
      bytesInExternal,
      bytesOutExternal,
      bytesInLoopback: sample.bytesInLoopback,
      bytesOutLoopback: sample.bytesOutLoopback
    };
  };

  if (samples.length === 1) {
    const byPid = new Map<number, NettopPidSample>();
    for (const [pid, value] of samples[0]!) {
      byPid.set(pid, normalize(value));
    }
    return {
      status: "ok",
      sampling: "cumulative",
      sampleWindowMs: NETTOP_INTERVAL_MS,
      sampleCount: 1,
      byPid,
      intervalBytesByPid: new Map()
    };
  }

  const byPid = new Map<number, NettopPidSample>();
  const intervalBytesByPid = new Map<number, number[]>();
  const intervalCount = samples.length - 1;
  const observedPids = new Set(
    samples.slice(1).flatMap((sample) => [...sample.keys()])
  );
  const difference = (now: number, before: number): number =>
    now >= before ? now - before : now;

  for (const pid of observedPids) {
    const aggregate: NettopPidSample = {
      pid,
      bytesInTotal: 0,
      bytesOutTotal: 0,
      bytesInExternal: 0,
      bytesOutExternal: 0,
      bytesInLoopback: 0,
      bytesOutLoopback: 0
    };
    const intervalBytes = Array.from({ length: intervalCount }, () => 0);
    // Diff against the last row seen for the process and for each connection.
    // nettop drops the row of a closed connection while the process row keeps
    // its cumulative total, so per-sample classified sums cannot be diffed:
    // the same bytes would be counted as loopback and again as external.
    let lastProcess = samples[0]!.get(pid);
    const lastConnections = new Map(lastProcess?.connections ?? []);

    for (let index = 1; index < samples.length; index += 1) {
      const current = samples[index]!.get(pid);
      if (!current) {
        continue;
      }

      const bytesInTotal = difference(current.bytesInTotal, lastProcess?.bytesInTotal ?? 0);
      const bytesOutTotal = difference(current.bytesOutTotal, lastProcess?.bytesOutTotal ?? 0);
      const rows = zeroRowBytes();
      for (const [key, connection] of current.connections) {
        const before = lastConnections.get(key);
        const bytesIn = difference(connection.bytesIn, before?.bytesIn ?? 0);
        const bytesOut = difference(connection.bytesOut, before?.bytesOut ?? 0);
        if (connection.loopback) {
          rows.bytesInLoopback += bytesIn;
          rows.bytesOutLoopback += bytesOut;
        } else {
          rows.bytesInExternal += bytesIn;
          rows.bytesOutExternal += bytesOut;
        }
        lastConnections.set(key, connection);
      }
      lastProcess = current;

      // Process-row bytes that no connection row explains stay in the ledger
      // as unclassified external traffic, as in the cumulative form.
      const bytesInExternal = Math.max(rows.bytesInExternal, bytesInTotal - rows.bytesInLoopback);
      const bytesOutExternal = Math.max(rows.bytesOutExternal, bytesOutTotal - rows.bytesOutLoopback);

      aggregate.bytesInTotal += bytesInTotal;
      aggregate.bytesOutTotal += bytesOutTotal;
      aggregate.bytesInExternal += bytesInExternal;
      aggregate.bytesOutExternal += bytesOutExternal;
      aggregate.bytesInLoopback += rows.bytesInLoopback;
      aggregate.bytesOutLoopback += rows.bytesOutLoopback;
      intervalBytes[index - 1] =
        bytesInExternal +
        bytesOutExternal +
        rows.bytesInLoopback +
        rows.bytesOutLoopback;
    }

    byPid.set(pid, aggregate);
    intervalBytesByPid.set(pid, intervalBytes);
  }

  return {
    status: "ok",
    sampling: "delta",
    sampleWindowMs: intervalCount * NETTOP_INTERVAL_MS,
    sampleCount: samples.length,
    byPid,
    intervalBytesByPid
  };
}

function zeroRowBytes(): ByteBreakdown {
  return {
    bytesInExternal: 0,
    bytesOutExternal: 0,
    bytesInLoopback: 0,
    bytesOutLoopback: 0
  };
}

export async function collectNettop(
  run: CommandRunner = defaultCommandRunner
): Promise<NettopCollection> {
  try {
    const output = await run("nettop", ["-x", "-L", "4", "-s", "1", "-n"]);
    return parseNettopOutput(output);
  } catch (error) {
    return {
      status: "failed",
      sampling: "cumulative",
      sampleWindowMs: NETTOP_INTERVAL_MS,
      sampleCount: 0,
      byPid: new Map(),
      intervalBytesByPid: new Map(),
      error: String(error)
    };
  }
}
