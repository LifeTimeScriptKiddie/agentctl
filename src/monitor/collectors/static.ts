import * as fs from "node:fs/promises";
import type { AgentSignal } from "../types.js";

export interface StaticSignalsResult {
  byAgent: Map<string, string[]>;
  warnings: string[];
}

export interface StatProvider {
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
}

const defaultStatProvider: StatProvider = fs;

export async function collectStaticSignals(
  registry: AgentSignal[],
  statProvider: StatProvider = defaultStatProvider
): Promise<StaticSignalsResult> {
  const byAgent = new Map<string, string[]>();
  const warnings: string[] = [];

  for (const signal of registry) {
    const staticSignals = new Set<string>();

    for (const configDir of signal.configDirs) {
      try {
        const stat = await statProvider.stat(configDir);
        if (stat.isDirectory()) {
          staticSignals.add("config_dir");
        }
      } catch (error) {
        const code = error as NodeJS.ErrnoException;
        if (code.code !== "ENOENT" && code.code !== "ENOTDIR") {
          warnings.push(`${signal.id} config check failed: ${String(error)}`);
        }
      }
    }

    for (const staticPath of signal.staticPaths ?? []) {
      try {
        const stat = await statProvider.stat(staticPath);
        if (stat.isFile() || stat.isDirectory()) {
          staticSignals.add("binary");
        }
      } catch (error) {
        const code = error as NodeJS.ErrnoException;
        if (code.code !== "ENOENT" && code.code !== "ENOTDIR") {
          warnings.push(`${signal.id} binary check failed: ${String(error)}`);
        }
      }
    }

    byAgent.set(signal.id, [...staticSignals]);
  }

  return { byAgent, warnings };
}
