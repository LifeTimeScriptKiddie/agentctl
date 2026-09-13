import type { OrchestrationResult } from './orchestrator.js';

/** Agents shown in status/agents lists — hides optional lanes that aren't ready. */
const HIDE_WHEN_UNAVAILABLE = new Set(['agy_image', 'claude']);

export function visibleAgentNames(
  names: string[],
  health: Record<string, { available: boolean }>,
): string[] {
  return names.filter((n) => {
    if (HIDE_WHEN_UNAVAILABLE.has(n) && !health[n]?.available) return false;
    return true;
  });
}

/** Format orchestration result as REPL output lines. */
export function formatOrchestrationForChat(
  result: OrchestrationResult,
  orchLabel: string,
): string[] {
  const lines: string[] = [];
  lines.push(`plan (${result.plan.steps.length} steps, ${orchLabel}):`);
  for (const s of result.plan.steps) {
    const who = s.agent ? ` → ${s.agent}${s.model ? `(${s.model})` : ''}${s.effort ? `@${s.effort}` : ''}` : '';
    const instr = s.instruction.length > 80 ? `${s.instruction.slice(0, 80)}…` : s.instruction;
    lines.push(`  ${s.id} [${s.type}] ${instr}${who}`);
  }
  if (result.status === 'planned') {
    lines.push('(dry plan — nothing executed)');
    return lines;
  }
  for (const o of result.outcomes) {
    const mark = o.ok ? '✓' : '✗';
    const who = o.agent ? `${o.agent}${o.model ? `(${o.model})` : ''}${o.effort ? `@${o.effort}` : ''}` : '—';
    lines.push(`${mark} ${o.id} → ${who} (${o.note})`);
  }
  if (result.synthesis) {
    lines.push('');
    lines.push(result.synthesis);
  } else if (result.outcomes.length > 0 && result.outcomes.every((o) => o.ok)) {
    lines.push('');
    lines.push(result.outcomes[result.outcomes.length - 1]!.output);
  }
  if (result.status !== 'done') {
    lines.push(`(orchestration ${result.status})`);
  }
  return lines;
}
