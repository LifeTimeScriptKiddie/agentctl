import { writePrivateFile } from '../privateFs.js';
import type { GraphRunRecord } from '../turnGraph.js';

const SEAM_VERSION = 'iseeagents.sessiongraph.seam.v2';
const SCHEMA_VERSION = 'iseeagents.context.v1';

function isErrorOutcome(outcome: string): boolean {
  return outcome.endsWith('_unavailable') || outcome === 'unknown_action';
}

/** Convert content-free shared_ptr workflow traces to SessionGraph generic events. */
export function runsToSessionGraphEvents(
  runs: GraphRunRecord[],
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];

  for (const run of runs) {
    const timestamp = new Date(run.at).toISOString();
    const rootId = `${run.id}:run`;
    events.push({
      id: rootId,
      parent_id: null,
      parent_ids: [],
      parent_relations: {},
      kind: 'run',
      role: 'system',
      name: run.graph,
      timestamp,
      content: '',
      is_error: false,
      iseeagents: {
        seamVersion: SEAM_VERSION,
        schemaVersion: SCHEMA_VERSION,
        sessionId: run.id,
        parentEventIds: [],
        lineageEventIds: [],
        source: run.source,
        terminal: run.terminal,
        evidenceStatus: run.evidenceStatus,
        totalMs: run.totalMs,
      },
    });

    let parentId = rootId;
    run.steps.forEach((step, index) => {
      const id = `${run.id}:step:${index + 1}`;
      const content = {
        action: step.action,
        outcome: step.outcome,
        ...(step.count !== undefined ? { count: step.count } : {}),
        ...(step.ms !== undefined ? { ms: step.ms } : {}),
      };
      events.push({
        id,
        parent_id: parentId,
        parent_ids: [parentId],
        parent_relations: { [parentId]: 'precedes' },
        kind: 'step',
        role: 'system',
        name: step.node,
        timestamp,
        content: JSON.stringify(content),
        is_error: isErrorOutcome(step.outcome),
      });
      parentId = id;
    });
  }

  return events;
}

/** Write SessionGraph generic events as a private JSONL file. */
export function writeSessionGraphExport(
  runs: GraphRunRecord[],
  outFile: string,
): { events: number } {
  const events = runsToSessionGraphEvents(runs);
  const jsonl = events.map((event) => JSON.stringify(event)).join('\n');
  writePrivateFile(outFile, jsonl.length > 0 ? `${jsonl}\n` : '');
  return { events: events.length };
}
