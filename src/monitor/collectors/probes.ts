import * as http from "node:http";
import type {
  AgentSignal,
  CollectorStatus,
  ModelInfo,
  ProbeAgentResult,
  ProbeCollection
} from "../types.js";

export type JsonRequester = (url: string, timeoutMs: number) => Promise<unknown>;
export const MAX_PROBE_RESPONSE_BYTES = 1024 * 1024;

function requestJson(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // A socket inactivity timeout alone permits an endless trickle response.
    const deadline = setTimeout(() => request.destroy(new Error("probe timed out")), timeoutMs);
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      let settled = false;
      response.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_PROBE_RESPONSE_BYTES) {
          settled = true;
          response.destroy();
          reject(new Error(`response exceeded ${MAX_PROBE_RESPONSE_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`HTTP ${statusCode}`));
          return;
        }

        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        } catch (error) {
          reject(new Error("invalid JSON"));
        }
      });
      response.on("error", (error) => {
        if (!settled) reject(error);
      });
    });

    request.on("close", () => clearTimeout(deadline));
    request.on("timeout", () => {
      request.destroy(new Error("probe timed out"));
    });
    request.on("error", reject);
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function modelName(record: Record<string, unknown>): string | null {
  for (const key of ["name", "model", "id", "key", "display_name"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function parseModels(payload: unknown): ModelInfo[] {
  const record = asRecord(payload);
  const candidate = Array.isArray(payload)
    ? payload
    : record && Array.isArray(record.models)
      ? record.models
      : record && Array.isArray(record.data)
        ? record.data
        : [];

  const models: ModelInfo[] = [];
  for (const value of candidate) {
    const item = asRecord(value);
    if (!item) {
      continue;
    }

    const name = modelName(item);
    if (!name) {
      continue;
    }

    const model: ModelInfo = { name };
    if (typeof item.state === "string") {
      model.state = item.state;
    }
    models.push(model);
  }
  return models;
}

function probeWarning(agentId: string, error: unknown): string {
  const message = String(error);
  if (/timed out|timeout|etimedout/i.test(message)) {
    return `${agentId} probe timed out`;
  }
  return `${agentId} probe failed: ${message}`;
}

function statusForResults(results: ProbeAgentResult[]): CollectorStatus {
  if (results.length === 0 || results.every((result) => result.status === "ok")) {
    return "ok";
  }
  if (results.every((result) => result.status === "failed")) {
    return "failed";
  }
  return "partial";
}

export interface ProbeOptions {
  /** Ports found from lsof for processes belonging to each agent. */
  portsByAgent?: Map<string, number[]>;
  /** Explicit overrides, useful for configured non-default local servers. */
  portOverrides?: Map<string, number>;
  timeoutMs?: number;
  requestJson?: JsonRequester;
}

/**
 * Probe only the documented local APIs. A reachable local model server is
 * enrichment: it does not turn a static config directory into a live signal,
 * and it does not imply that a model is actively generating.
 */
export async function collectProbes(
  registry: AgentSignal[],
  options: ProbeOptions = {}
): Promise<ProbeCollection> {
  const timeoutMs = options.timeoutMs ?? 1000;
  const requester = options.requestJson ?? requestJson;
  const portsByAgent = options.portsByAgent ?? new Map<string, number[]>();
  const portOverrides = options.portOverrides ?? new Map<string, number>();
  const localSignals = registry.filter((signal) => signal.localProbe && (portsByAgent.get(signal.id)?.length ?? 0) > 0);
  const byAgent = new Map<string, ProbeAgentResult>();
  const warnings: string[] = [];

  await Promise.all(
    localSignals.map(async (signal) => {
      const probe = signal.localProbe;
      if (!probe) {
        return;
      }

      const override = portOverrides.get(signal.id);
      const discovered = portsByAgent.get(signal.id) ?? [];
      const candidates = override !== undefined
        ? discovered.filter((port) => port === override)
        : discovered.includes(probe.defaultPort) ? [probe.defaultPort] : [...new Set(discovered)].slice(0, 1);

      let lastError: unknown = new Error("no candidate port");
      for (const port of candidates) {
        const url = `http://127.0.0.1:${port}${probe.path}`;
        try {
          const payload = await requester(url, timeoutMs);
          byAgent.set(signal.id, {
            status: "ok",
            reachable: true,
            models: parseModels(payload),
            warnings: []
          });
          return;
        } catch (error) {
          lastError = error;
        }
      }

      const warning = probeWarning(signal.id, lastError);
      warnings.push(warning);
      byAgent.set(signal.id, {
        status: "failed",
        reachable: false,
        models: [],
        warnings: [warning]
      });
    })
  );

  const results = [...byAgent.values()];
  return {
    status: statusForResults(results),
    byAgent,
    warnings
  };
}

export { parseModels, requestJson };
