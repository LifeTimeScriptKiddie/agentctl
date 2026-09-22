import { describe, it, expect } from 'vitest';
import { readPlannerRoutingRules, readModelRoutingGuide } from '../src/assets.js';
import { buildPlannerPrompt } from '../src/core/orchestrator.js';

describe('MODEL-ROUTING.md', () => {
  it('loads the routing guide from docs/', () => {
    const guide = readModelRoutingGuide();
    expect(guide).toContain('Cursor Models allowance');
    expect(guide).toContain('gpt-daybreak-blue-latest');
    expect(guide).toContain('PLANNER_RULES_START');
  });

  it('extracts planner rules for orchestrator injection', () => {
    const rules = readPlannerRoutingRules();
    expect(rules).toContain('Use only available lanes');
    expect(rules).toContain('claude / opus');
    expect(rules).not.toContain('PLANNER_RULES_START');
  });

  it('buildPlannerPrompt embeds routing rules', () => {
    const prompt = buildPlannerPrompt('test goal', '- codex [available]', 'CUSTOM RULES');
    expect(prompt).toContain('CUSTOM RULES');
    expect(prompt).toContain('MODEL ROUTING RULES');
    expect(prompt).toContain('test goal');
  });
});
