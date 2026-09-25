/**
 * Fixed benchmark for the self-improvement loops (`agentctl bench`).
 *
 * Routing tier: deterministic, no model calls. Every packaged lane is treated
 * as available, so the score depends only on the router and the routing
 * overrides under test — never on what this machine has installed.
 * Live tier: real `delegate` calls with checkable answers; opt-in, costs quota.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { route, type RouterAgent } from '../core/router.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { AdapterCapabilities } from '../schema/index.js';

const CapSchema = z.enum([
  'canReadFiles', 'canWriteFiles', 'canRunShell', 'canAccessNetwork', 'canModifyRepo', 'canPublish', 'canUseBrowser',
]);

const RoutingCaseSchema = z.object({
  id: z.string().min(1),
  task: z.string().min(1),
  mustHave: z.array(CapSchema).default([]),
  notAgents: z.array(z.string()).default([]),
  expect: z.string().optional(),
});

const LiveCaseSchema = z.object({
  id: z.string().min(1),
  task: z.string().min(1),
  contains: z.array(z.string()).default([]),
  regex: z.string().optional(),
}).refine((c) => c.contains.length > 0 || c.regex, { message: 'live case needs contains or regex' });

const CasesSchema = z.object({
  routing: z.array(RoutingCaseSchema),
  live: z.array(LiveCaseSchema).default([]),
});

export type RoutingCase = z.infer<typeof RoutingCaseSchema>;
export type LiveCase = z.infer<typeof LiveCaseSchema>;
export type BenchCases = z.infer<typeof CasesSchema>;
export type Prefer = Readonly<Record<string, readonly string[]>>;

export function casesPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'cases.yaml');
}

export function loadCases(path: string = casesPath()): BenchCases {
  return CasesSchema.parse(parseYaml(readFileSync(path, 'utf8')));
}

export interface RoutingCaseResult {
  id: string;
  agent: string | null;
  /** hard invariant violations; empty = pass */
  violations: string[];
  expect?: string;
  expectMet?: boolean;
}

export interface RoutingBenchResult {
  total: number;
  passed: number;
  /** ids of cases that broke a hard invariant */
  failed: string[];
  softTotal: number;
  softMet: number;
  cases: RoutingCaseResult[];
}

/** Every lane in the registry except the canned test lane, all available. */
export function benchRoster(registry: AdapterRegistry): RouterAgent[] {
  return registry.names()
    .filter((n) => n !== 'dry_run')
    .map((name) => ({ name, capabilities: registry.get(name).capabilities(), available: true }));
}

export function runRoutingBench(cases: RoutingCase[], roster: RouterAgent[], prefer: Prefer = {}): RoutingBenchResult {
  const caps = new Map(roster.map((a) => [a.name, a.capabilities]));
  const results = cases.map((c): RoutingCaseResult => {
    const agent = route(c.task, roster, { prefer }).agent;
    const violations: string[] = [];
    if (!agent) violations.push('no lane chosen');
    else {
      const have = caps.get(agent) as AdapterCapabilities | undefined;
      for (const cap of c.mustHave) if (!have?.[cap]) violations.push(`${agent} lacks ${cap}`);
      if (c.notAgents.includes(agent)) violations.push(`${agent} is excluded for this task`);
    }
    return {
      id: c.id, agent, violations,
      ...(c.expect ? { expect: c.expect, expectMet: agent === c.expect } : {}),
    };
  });
  const soft = results.filter((r) => r.expect);
  return {
    total: results.length,
    passed: results.filter((r) => r.violations.length === 0).length,
    failed: results.filter((r) => r.violations.length > 0).map((r) => r.id),
    softTotal: soft.length,
    softMet: soft.filter((r) => r.expectMet).length,
    cases: results,
  };
}

/** Hard cases the candidate breaks that the baseline passed. */
export function newFailures(baseline: RoutingBenchResult, candidate: RoutingBenchResult): string[] {
  const before = new Set(baseline.failed);
  return candidate.failed.filter((id) => !before.has(id));
}

export interface LiveCaseResult {
  id: string;
  agent: string | null;
  ok: boolean;
  passed: boolean;
  detail: string;
  durationMs: number;
}

export function checkLiveAnswer(c: LiveCase, text: string): boolean {
  const lower = text.toLowerCase();
  if (!c.contains.every((s) => lower.includes(s.toLowerCase()))) return false;
  if (c.regex && !new RegExp(c.regex, 'im').test(text.trim())) return false;
  return true;
}

export type LiveRunner = (task: string) => Promise<{ agent: string | null; ok: boolean; text: string }>;

export async function runLiveBench(cases: LiveCase[], runner: LiveRunner): Promise<{ total: number; passed: number; cases: LiveCaseResult[] }> {
  const results: LiveCaseResult[] = [];
  for (const c of cases) {
    const start = Date.now();
    try {
      const r = await runner(c.task);
      const passed = r.ok && checkLiveAnswer(c, r.text);
      results.push({ id: c.id, agent: r.agent, ok: r.ok, passed, detail: r.text.trim().slice(0, 160), durationMs: Date.now() - start });
    } catch (e) {
      results.push({ id: c.id, agent: null, ok: false, passed: false, detail: e instanceof Error ? e.message : String(e), durationMs: Date.now() - start });
    }
  }
  return { total: results.length, passed: results.filter((r) => r.passed).length, cases: results };
}
