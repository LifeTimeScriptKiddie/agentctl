/**
 * A stand-in for the shared_ptr store, for agentctl's briefing tests. agentctl
 * reads local briefings from the shared_ptr CLI as a contract ResumeBriefing
 * packet; this fake produces the same packet in memory, so the tests exercise
 * agentctl's side (formatting, quoting, injection gates) without shared_ptr.
 */
import type { ResumeBriefing } from '@lifetimescriptkiddie/shared-ptr-contract';
import { setLocalBriefingSource } from '../../src/memory/briefingProvider.js';

interface CheckpointInput {
  workspace: string; revision?: number | null; goal: string; state: string; blockers?: string[];
  nextAction: string; decisionRefs?: string[]; source: string;
}

const checkpoints = new Map<string, CheckpointInput & { revision: number; updatedAt: number }>();

function briefing(workspace: string, provider: string): ResumeBriefing {
  const cp = checkpoints.get(workspace);
  return {
    packet: {
      version: 1, kind: 'resume_briefing', workspace, provider,
      checkpoint: cp ? {
        revision: cp.revision, goal: cp.goal, state: cp.state, blockers: cp.blockers ?? [],
        nextAction: cp.nextAction, source: cp.source, updatedAt: cp.updatedAt,
      } : null,
      // like the real store: this fake holds no decisions, so every referenced id is unresolved
      decisions: [], omittedDecisionRefs: [], unresolvedDecisionRefs: [...(cp?.decisionRefs ?? [])],
    },
  } as ResumeBriefing;
}

/** Same surface the tests used on shared_ptr's MemoryStore. */
export class MemoryStore {
  static async open(): Promise<MemoryStore> { return new MemoryStore(); }
  setCheckpoint(input: CheckpointInput) {
    const prev = checkpoints.get(input.workspace);
    const next = { ...input, revision: (prev?.revision ?? 0) + 1, updatedAt: Date.now() };
    checkpoints.set(input.workspace, next);
    return next;
  }
  resumeBriefing(workspace: string, provider: string): ResumeBriefing { return briefing(workspace, provider); }
  close(): void { /* nothing to release */ }
}

/** Fresh fake state, installed as agentctl's local briefing source. */
export function useFakeSharedPtr(): void {
  checkpoints.clear();
  setLocalBriefingSource(async (workspace, provider) => briefing(workspace, provider));
}
