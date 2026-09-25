import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthContext, Classification } from '../authContext.js';
import { MemoryStore } from '../store.js';
import { isServing } from '../runtime.js';
import {
  resetTurnGraphCache,
  type ContextRetrievalResult,
  type GraphRunRecord,
} from '../turnGraph.js';

export type BenchIdentity = 'member' | 'outsider';

export interface BenchMemoryFixture {
  /** Stable benchmark id; store UUIDs are normalized back to this value. */
  id: string;
  text: string;
  source: string;
  providers: Array<'claude'>;
  state: 'accepted';
  kind: string;
  ownerUserId?: string;
  allowedGroups: string[];
  classification: Classification;
  visibility: 'team';
}

export interface BenchFixture {
  workspace: 'bench';
  memories: BenchMemoryFixture[];
  identities: Record<BenchIdentity, AuthContext>;
  queries: string[];
}

export const BENCH_SECRET_TEAM_MEMORY_ID = 'secret-team';
export const BENCH_CONFIDENTIAL_MEMORY_ID = 'confidential';

/** Fixed corpus, identities, and workload used for graph-edit replay gates. */
export const BENCH_FIXTURE: BenchFixture = {
  workspace: 'bench',
  memories: [
    {
      id: 'rollback',
      text: 'The team rollback runbook assigns the rollback owner to the platform lead after a failed release.',
      source: 'bench:rollback',
      providers: ['claude'],
      state: 'accepted',
      kind: 'process',
      allowedGroups: [],
      classification: 'internal',
      visibility: 'team',
    },
    {
      id: 'deploy',
      text: 'The team deploys each service with Argo during the Tuesday release window.',
      source: 'bench:deploy',
      providers: ['claude'],
      state: 'accepted',
      kind: 'process',
      allowedGroups: [],
      classification: 'internal',
      visibility: 'team',
    },
    {
      id: 'on-call',
      text: 'The team on-call service owner acknowledges PagerDuty alerts and follows the incident runbook.',
      source: 'bench:on-call',
      providers: ['claude'],
      state: 'accepted',
      kind: 'ops_note',
      allowedGroups: [],
      classification: 'internal',
      visibility: 'team',
    },
    {
      id: 'tls',
      text: 'The team TLS runbook requires mTLS for every internal service connection.',
      source: 'bench:tls',
      providers: ['claude'],
      state: 'accepted',
      kind: 'decision',
      allowedGroups: [],
      classification: 'internal',
      visibility: 'team',
    },
    {
      id: 'backups',
      text: 'The team database backup owner runs a Borg restore drill every Friday.',
      source: 'bench:backups',
      providers: ['claude'],
      state: 'accepted',
      kind: 'process',
      allowedGroups: [],
      classification: 'internal',
      visibility: 'team',
    },
    {
      id: 'incident-severity',
      text: 'The team declares severity one when a customer-facing outage spans multiple regions.',
      source: 'bench:incident-severity',
      providers: ['claude'],
      state: 'accepted',
      kind: 'decision',
      allowedGroups: [],
      classification: 'internal',
      visibility: 'team',
    },
    {
      id: 'feature-flags',
      text: 'The team disables a risky service feature with a LaunchDarkly flag before rollback.',
      source: 'bench:feature-flags',
      providers: ['claude'],
      state: 'accepted',
      kind: 'decision',
      allowedGroups: [],
      classification: 'internal',
      visibility: 'team',
    },
    {
      id: 'observability',
      text: 'The team retains service observability logs in Loki for thirty days.',
      source: 'bench:observability',
      providers: ['claude'],
      state: 'accepted',
      kind: 'ops_note',
      allowedGroups: [],
      classification: 'internal',
      visibility: 'team',
    },
    {
      id: BENCH_SECRET_TEAM_MEMORY_ID,
      text: 'The secret-team HSM recovery ceremony uses the unique token saffron.',
      source: 'bench:secret-team',
      providers: ['claude'],
      state: 'accepted',
      kind: 'process',
      // The prescribed member is the owner; every other reader must belong to secret-team.
      ownerUserId: 'bench-member',
      allowedGroups: ['secret-team'],
      classification: 'internal',
      visibility: 'team',
    },
    {
      id: BENCH_CONFIDENTIAL_MEMORY_ID,
      text: 'The confidential acquisition project uses the unique codename nightjar.',
      source: 'bench:confidential',
      providers: ['claude'],
      state: 'accepted',
      kind: 'decision',
      allowedGroups: [],
      classification: 'confidential',
      visibility: 'team',
    },
  ],
  identities: {
    member: { userId: 'bench-member', groups: ['team'], clearance: 'confidential' },
    outsider: { userId: 'bench-outsider', groups: ['other'], clearance: 'internal' },
  },
  queries: [
    '   ',
    'quantum unicorn',
    'rollback owner',
    'Argo',
    'PagerDuty',
    'mTLS',
    'Borg',
    'saffron',
    'nightjar',
    'team',
    'service',
    'runbook owner',
  ],
};

/** Lower-case alias for callers that prefer ordinary value naming. */
export const benchFixture = BENCH_FIXTURE;

export interface BenchCaseResult {
  query: string;
  identity: BenchIdentity;
  ids: string[];
  terminal: ContextRetrievalResult['terminal'];
  nodes: string[];
}

export interface BenchInvariants {
  aclLeaks: Array<Pick<BenchCaseResult, 'query' | 'identity' | 'ids'>>;
  emptyQueryNotAbstained: Array<Pick<BenchCaseResult, 'query' | 'identity' | 'terminal'>>;
}

export interface BenchResult {
  cases: BenchCaseResult[];
  runs: GraphRunRecord[];
  invariants: BenchInvariants;
}

export interface BenchComparison {
  sameResults: boolean;
  diffs: Array<{ query: string; identity: string; before: string[]; after: string[] }>;
  hardFailures: string[];
}

const ENV_KEYS = [
  'SHARED_PTR_HOME',
  'AGENTCTL_HOME',
  'SHARED_PTR_GRAPH_EXECUTOR',
  'SHARED_PTR_GRAPH_RUN_LOG',
] as const;

function restoreEnv(previous: ReadonlyMap<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function evaluateInvariants(cases: BenchCaseResult[]): BenchInvariants {
  const restricted = new Set([BENCH_SECRET_TEAM_MEMORY_ID, BENCH_CONFIDENTIAL_MEMORY_ID]);
  return {
    aclLeaks: cases
      .filter((c) => c.identity === 'outsider' && c.ids.some((id) => restricted.has(id)))
      .map(({ query, identity, ids }) => ({ query, identity, ids: [...ids] })),
    emptyQueryNotAbstained: cases
      .filter((c) => c.query.trim() === '' && c.terminal !== 'abstain_empty_query')
      .map(({ query, identity, terminal }) => ({ query, identity, terminal })),
  };
}

async function seedFixture(store: MemoryStore): Promise<Map<string, string>> {
  const stableIdByStoreId = new Map<string, string>();
  for (const memory of BENCH_FIXTURE.memories) {
    const proposed = store.save({
      workspace: BENCH_FIXTURE.workspace,
      text: memory.text,
      source: memory.source,
      providers: [...memory.providers],
      state: 'proposed',
      key: `bench-${memory.id}`,
      kind: memory.kind,
      ownerUserId: memory.ownerUserId,
      allowedGroups: [...memory.allowedGroups],
      classification: memory.classification,
      visibility: memory.visibility,
    });
    const accepted = store.change(
      BENCH_FIXTURE.workspace,
      proposed.id,
      proposed.revision,
      'accept',
    );
    stableIdByStoreId.set(accepted.id, memory.id);
  }
  return stableIdByStoreId;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Replay the fixed query/identity matrix against a bundled or supplied graph.
 * It changes process-wide settings while it runs, so it refuses to run inside
 * a serving process and runs one replay at a time.
 */
export function runBench(graphYaml: string | null): Promise<BenchResult> {
  if (isServing()) throw new Error('runBench changes process-wide settings; run `shared_ptr improve` as its own process, not inside serve');
  const next = queue.then(() => runBenchNow(graphYaml));
  queue = next.catch(() => undefined);
  return next;
}

async function runBenchNow(graphYaml: string | null): Promise<BenchResult> {
  const home = mkdtempSync(join(tmpdir(), 'shared-ptr-graph-bench-'));
  const previous = new Map<string, string | undefined>(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  const database = join(home, 'memory', 'memory.sqlite');

  try {
    process.env.SHARED_PTR_HOME = home;
    // The benchmark always exercises the graph executor and always captures its runs.
    process.env.SHARED_PTR_GRAPH_EXECUTOR = 'graph';
    process.env.SHARED_PTR_GRAPH_RUN_LOG = '1';
    if (graphYaml !== null) {
      mkdirSync(join(home, 'config'), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, 'config', 'turn-graph.yaml'), graphYaml, { mode: 0o600 });
    }
    resetTurnGraphCache();

    let stableIdByStoreId: Map<string, string>;
    const writer = await MemoryStore.open(database, { auth: null });
    try {
      stableIdByStoreId = await seedFixture(writer);
    } finally {
      writer.close();
    }

    const cases: BenchCaseResult[] = [];
    for (const identity of ['member', 'outsider'] as const) {
      const store = await MemoryStore.open(database, { auth: BENCH_FIXTURE.identities[identity] });
      try {
        for (const query of BENCH_FIXTURE.queries) {
          const result = await store.searchWithGraph(
            BENCH_FIXTURE.workspace,
            query,
            'claude',
            50,
            null,
            { laya: false, jev: false },
          );
          cases.push({
            query,
            identity,
            ids: result.memories
              .map((memory) => stableIdByStoreId.get(memory.id) ?? memory.id)
              .sort(),
            terminal: result.terminal,
            nodes: result.trace.map((step) => step.node),
          });
        }
      } finally {
        store.close();
      }
    }

    const reader = await MemoryStore.open(database, { auth: null });
    try {
      return {
        cases,
        runs: reader.listGraphRuns(),
        invariants: evaluateInvariants(cases),
      };
    } finally {
      reader.close();
    }
  } finally {
    resetTurnGraphCache();
    restoreEnv(previous);
    rmSync(home, { recursive: true, force: true });
  }
}

function caseKey(c: Pick<BenchCaseResult, 'query' | 'identity'>): string {
  return JSON.stringify([c.query, c.identity]);
}

export function compareBench(before: BenchResult, after: BenchResult): BenchComparison {
  const beforeByCase = new Map(before.cases.map((c) => [caseKey(c), c]));
  const afterByCase = new Map(after.cases.map((c) => [caseKey(c), c]));
  const orderedKeys = [
    ...before.cases.map(caseKey),
    ...after.cases.map(caseKey).filter((key) => !beforeByCase.has(key)),
  ];
  const diffs: BenchComparison['diffs'] = [];

  for (const key of orderedKeys) {
    const beforeCase = beforeByCase.get(key);
    const afterCase = afterByCase.get(key);
    const beforeIds = beforeCase?.ids ?? [];
    const afterIds = afterCase?.ids ?? [];
    if (
      beforeCase
      && afterCase
      && beforeIds.length === afterIds.length
      && beforeIds.every((id, i) => id === afterIds[i])
    ) continue;
    const [query, identity] = JSON.parse(key) as [string, string];
    diffs.push({ query, identity, before: [...beforeIds], after: [...afterIds] });
  }

  // Re-evaluate cases so a manually assembled result cannot carry stale invariant metadata.
  const observed = evaluateInvariants(after.cases);
  const hardFailures: string[] = [];
  if (after.invariants.aclLeaks.length > 0 || observed.aclLeaks.length > 0) hardFailures.push('aclLeaks');
  if (
    after.invariants.emptyQueryNotAbstained.length > 0
    || observed.emptyQueryNotAbstained.length > 0
  ) hardFailures.push('emptyQueryNotAbstained');

  return { sameResults: diffs.length === 0, diffs, hardFailures };
}
