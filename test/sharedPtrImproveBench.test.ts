import { beforeAll, describe, expect, it } from 'vitest';
import {
  BENCH_CONFIDENTIAL_MEMORY_ID,
  BENCH_FIXTURE,
  BENCH_SECRET_TEAM_MEMORY_ID,
  compareBench,
  runBench,
  type BenchResult,
} from '../packages/shared_ptr/src/improve/bench.js';

describe('shared_ptr graph improvement benchmark', () => {
  let bundled: BenchResult;

  beforeAll(async () => {
    bundled = await runBench(null);
  });

  it('passes hard invariants and applies group and classification ACLs', () => {
    expect(bundled.invariants.aclLeaks).toEqual([]);
    expect(bundled.invariants.emptyQueryNotAbstained).toEqual([]);

    const memberSecret = bundled.cases.find(
      (c) => c.identity === 'member' && c.query === 'saffron',
    );
    const outsiderSecret = bundled.cases.find(
      (c) => c.identity === 'outsider' && c.query === 'saffron',
    );
    expect(memberSecret?.ids).toContain(BENCH_SECRET_TEAM_MEMORY_ID);
    expect(outsiderSecret?.ids).not.toContain(BENCH_SECRET_TEAM_MEMORY_ID);

    const outsiderConfidential = bundled.cases.find(
      (c) => c.identity === 'outsider' && c.query === 'nightjar',
    );
    expect(outsiderConfidential?.ids).not.toContain(BENCH_CONFIDENTIAL_MEMORY_ID);
    expect(bundled.runs).toHaveLength(BENCH_FIXTURE.queries.length * 2);
  });

  it('compares an identical result as unchanged', () => {
    expect(compareBench(bundled, bundled)).toMatchObject({
      sameResults: true,
      diffs: [],
      hardFailures: [],
    });
  });

  it('reports a changed id list as a case diff', () => {
    const changedCase = bundled.cases[0]!;
    const after: BenchResult = {
      ...bundled,
      cases: bundled.cases.map((c, index) => index === 0
        ? { ...c, ids: [...c.ids, 'changed-memory'] }
        : { ...c, ids: [...c.ids] }),
    };

    const comparison = compareBench(bundled, after);
    expect(comparison.sameResults).toBe(false);
    expect(comparison.diffs).toEqual([{
      query: changedCase.query,
      identity: changedCase.identity,
      before: changedCase.ids,
      after: [...changedCase.ids, 'changed-memory'],
    }]);
  });

  it('restores SHARED_PTR_HOME and AGENTCTL_HOME after a run', async () => {
    const originalSharedPtrHome = process.env.SHARED_PTR_HOME;
    const originalAgentctlHome = process.env.AGENTCTL_HOME;
    process.env.SHARED_PTR_HOME = '/tmp/bench-original-shared-ptr-home';
    process.env.AGENTCTL_HOME = '/tmp/bench-original-agentctl-home';
    try {
      await runBench(null);
      expect(process.env.SHARED_PTR_HOME).toBe('/tmp/bench-original-shared-ptr-home');
      expect(process.env.AGENTCTL_HOME).toBe('/tmp/bench-original-agentctl-home');
    } finally {
      if (originalSharedPtrHome === undefined) delete process.env.SHARED_PTR_HOME;
      else process.env.SHARED_PTR_HOME = originalSharedPtrHome;
      if (originalAgentctlHome === undefined) delete process.env.AGENTCTL_HOME;
      else process.env.AGENTCTL_HOME = originalAgentctlHome;
    }
  });
});
