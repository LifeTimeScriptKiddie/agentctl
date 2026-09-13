import { describe, it, expect } from 'vitest';
import {
  ChatLedger, formatFlowCompact, formatTokenCount, formatUsageCompact, addUsage, emptyUsageTotals,
  renderChatFooter, shortFlowLabel, stripAnsi, OrchProgressTracker, FlowRouteTracker, displayFlowNode,
} from '../src/tui/chatDashboard.js';

describe('chatDashboard', () => {
  it('formatTokenCount scales k and M', () => {
    expect(formatTokenCount(500)).toBe('500');
    expect(formatTokenCount(2400)).toBe('2.4k');
    expect(formatTokenCount(2_400_000)).toBe('2.40M');
  });

  it('addUsage sums reported tokens and cost', () => {
    const t = addUsage(emptyUsageTotals(), { inputTokens: 100, outputTokens: 50, costUsd: 0.01 });
    expect(t.inputTokens).toBe(100);
    expect(t.costUsd).toBeCloseTo(0.01);
    expect(t.reportedCalls).toBe(1);
  });

  it('addUsage estimates when tokens missing', () => {
    const t = addUsage(emptyUsageTotals(), null, 'abcd'.repeat(100));
    expect(t.estimatedTokens).toBe(100);
    expect(t.estimatedCalls).toBe(1);
  });

  it('shortFlowLabel abbreviates orch and models', () => {
    expect(shortFlowLabel('orch(codex/sol)')).toBe('orch');
    expect(shortFlowLabel('codex/gpt-5.6-luna')).toBe('codex');
  });

  it('formatFlowCompact chains hops with ASCII arrows', () => {
    const line = formatFlowCompact([
      { from: 'you', to: 'orch(codex/sol)' },
      { from: 'orch(codex/sol)', to: 'codex/gpt-5.6-luna' },
    ], 120);
    expect(line).toContain('you->orch->codex');
  });

  it('formatFlowCompact truncates long paths from the left', () => {
    const hops = Array.from({ length: 12 }, (_, i) => ({
      from: 'a',
      to: `agent${i}/model`,
    }));
    const line = formatFlowCompact(hops, 40);
    expect(line.startsWith('…->')).toBe(true);
    expect(stripAnsi(line).length).toBeLessThanOrEqual(40);
  });

  it('FlowRouteTracker shows agent travel with phases', () => {
    const route = new FlowRouteTracker();
    route.addLeg('you', 'orch(codex/gpt-5.6-sol)');
    route.addOrchPhase('orch(codex/gpt-5.6-sol)', 'plan');
    route.addLeg('orch(codex/gpt-5.6-sol)', 'codex/gpt-5.6-luna');
    const line = route.formatRoute(120);
    expect(line).toMatch(/you→orch·sol/);
    expect(line).toMatch(/orch·sol\[plan\]/);
    expect(line).toMatch(/orch·sol→codex·luna/);
    route.setActive('orch·sol → cursor·sol');
    expect(route.formatNow()).toContain('cursor·sol');
  });

  it('displayFlowNode shortens models', () => {
    expect(displayFlowNode('codex', 'gpt-5.6-luna')).toBe('codex·luna');
    expect(displayFlowNode('orch(codex/gpt-5.6-sol)')).toBe('orch·sol');
  });

  it('OrchProgressTracker formats live steps with cost', () => {
    const p = new OrchProgressTracker();
    p.start();
    p.markPlanDone();
    p.recordStep('s1', 'codex', true, 0.002);
    expect(p.format(80)).toContain('plan✓');
    expect(p.format(80)).toContain('s1:codex✓');
    expect(p.format(80)).toContain('$0.0020');
  });

  it('FlowRouteTracker builds diagram and hop regions', () => {
    const route = new FlowRouteTracker();
    route.addLeg('you', 'orch·sol');
    route.addLeg('orch·sol', 'codex·luna');
    const diagram = route.formatFlowDiagram(80);
    expect(diagram).toContain('you');
    expect(diagram).toContain('codex·luna');
    const regions = route.hopRegions(diagram);
    expect(regions.length).toBeGreaterThanOrEqual(2);
    expect(regions[0]!.agent).toBe('you');
  });

  it('ChatLedger records agent hops', () => {
    const ledger = new ChatLedger();
    ledger.recordAgentCall('you', 'codex', 'gpt-5.6-luna', { inputTokens: 10, outputTokens: 5, costUsd: null }, 'hi');
    expect(ledger.flowHops).toHaveLength(1);
    expect(ledger.usageTotals.inputTokens).toBe(10);
  });

  it('renderChatFooter is compact (no box chars)', () => {
    const ledger = new ChatLedger();
    ledger.recordHop('you', 'codex/luna', { inputTokens: 1, outputTokens: 2, costUsd: 0.001 });
    const lines = renderChatFooter({
      sessionName: 'demo',
      orchMode: true,
      orchLabel: 'codex/gpt-5.6-sol',
      hops: ledger.flowHops,
      totals: ledger.usageTotals,
      width: 60,
    });
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.join('\n')).not.toMatch(/[┌└│]/);
    expect(lines.join('\n')).toMatch(/route/);
    expect(formatUsageCompact(ledger.usageTotals)).toMatch(/in/);
  });
});
