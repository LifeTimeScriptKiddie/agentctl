import type { GenericEvent } from './export.js';
import type { PromptBehaviorAnalysis } from './promptBehavior.js';
import { SPEC_THRESHOLDS } from './improve.js';
import { directive, type HarnessObservation } from './harness.js';

/**
 * Pictures of the graphs agentctl exports (content-free, like the exports):
 * - `workflowMermaid`: one job or MCP session, prompt nodes and behavior nodes in
 *   separate lanes, colored by outcome, with lint codes and failure classes on
 *   the nodes and typed edges labeled;
 * - `overviewMermaid`: all callers → graph outcomes → refusal reasons / spec
 *   issues behind failures, the picture of `promptBehavior`;
 * - `graphHtml`: both in one self-contained page (Mermaid from a CDN, with the
 *   diagram source shown if it cannot load).
 */

/** Mermaid-safe label text (quotes and angle brackets become entities). */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;');
}

export const label = (...lines: Array<string | null | undefined | false>) => `"${lines.filter(Boolean).map((l) => esc(String(l))).join('<br/>')}"`;

export const CLASSES = [
  'classDef kAsked fill:#dbeafe,stroke:#2563eb,color:#0f172a',
  'classDef kIssue fill:#fef3c7,stroke:#d97706,color:#0f172a',
  'classDef kAct fill:#f1f5f9,stroke:#64748b,color:#0f172a',
  'classDef kOk fill:#dcfce7,stroke:#16a34a,color:#0f172a',
  'classDef kErr fill:#fee2e2,stroke:#dc2626,color:#0f172a',
  // Terminal outcomes: light fill + heavy border, so the dark label text stays legible in every renderer.
  'classDef kDone fill:#bbf7d0,stroke:#15803d,stroke-width:3px,color:#0f172a',
  'classDef kFail fill:#fecaca,stroke:#b91c1c,stroke-width:3px,color:#0f172a',
  // Harness: what agentctl told the model (violet), and directives the graph cannot check (dashed).
  'classDef kHarness fill:#ede9fe,stroke:#7c3aed,color:#0f172a',
  'classDef kBlind fill:#f8fafc,stroke:#94a3b8,stroke-dasharray:4 3,color:#475569',
];

function args(e: GenericEvent): Record<string, unknown> {
  return e.arguments ?? {};
}

function nodeText(e: GenericEvent): { text: string; cls: string } {
  const a = args(e);
  const issues = Array.isArray(a.issues) && a.issues.length ? `⚠ ${(a.issues as string[]).join(', ')}` : null;
  const cost = typeof e.usage?.cost_usd === 'number' && e.usage.cost_usd > 0 ? `$${e.usage.cost_usd.toFixed(4)}` : null;
  switch (e.kind) {
    case 'message':
      if (e.parent_id === null) {
        const shape = typeof a.tasks === 'number' ? `${a.tasks} task(s) · depth ${a.depth ?? '?'} · width ${a.width ?? '?'}` : null;
        return {
          text: label(`request ${e.name ?? ''}`, a.size ? `size ${a.size}${a.context ? ' · context' : ' · no context'}` : null, shape, issues),
          cls: issues ? 'kIssue' : 'kAsked',
        };
      }
      return { text: label(e.name ?? 'message'), cls: 'kAct' };
    case 'task_spec':
      return {
        text: label(e.name ?? 'task', a.acceptance ? 'acceptance ✓' : null, a.pinned_agent ? 'agent pinned' : null, issues),
        cls: issues ? 'kIssue' : 'kAsked',
      };
    case 'job_start':
      return { text: label(`start ${e.name ?? ''}`), cls: 'kAct' };
    case 'tool_call':
      return {
        text: label(e.name ?? 'kAct', typeof a.model === 'string' ? a.model : null, issues),
        cls: e.is_error ? 'kErr' : issues ? 'kIssue' : 'kAct',
      };
    case 'tool_result':
      return {
        text: label(e.is_error ? `✗ ${String(a.failureClass ?? a.status ?? 'error')}` : '✓ result', cost,
          typeof a.decision === 'string' ? `lead: ${a.decision}${typeof a.tasks === 'number' ? ` ${a.tasks} task(s)` : ''}${typeof a.rejection === 'string' ? ` (${a.rejection})` : ''}` : null),
        cls: e.is_error ? 'kErr' : 'kOk',
      };
    case 'step':
      return { text: label(e.is_error ? '✗ task settled' : '✓ task settled', typeof a.attempts === 'number' && a.attempts !== 1 ? `${a.attempts} attempts` : null), cls: e.is_error ? 'kErr' : 'kOk' };
    case 'finish':
      return { text: label(e.name ?? 'finish'), cls: e.is_error ? 'kFail' : 'kDone' };
    default:
      return { text: label(e.name ?? e.kind), cls: e.is_error ? 'kErr' : 'kAct' };
  }
}

/**
 * One job or MCP session as a left-to-right workflow. With `harness`
 * observations, a third lane shows the directives the models read: a solid
 * `✓` edge runs from a directive to behavior that followed it, and a dashed red
 * `✗` edge runs back from behavior that did not follow it to the directive.
 */
export function workflowMermaid(events: GenericEvent[], title?: string, harness: HarnessObservation[] = []): string {
  const idOf = new Map(events.map((e, i) => [e.id, `n${i}`]));
  const isPrompt = (e: GenericEvent) => e.kind === 'task_spec' || (e.kind === 'message' && e.parent_id === null);
  const lines = ['flowchart LR'];
  if (title) lines.unshift(`%% ${title}`);
  const node = (e: GenericEvent) => {
    const { text, cls } = nodeText(e);
    return `    ${idOf.get(e.id)}[${text}]:::${cls}`;
  };
  const prompt = events.filter(isPrompt);
  if (prompt.length && prompt.length < events.length) {
    lines.push('  subgraph P["asked (prompt)"]', '    direction TB', ...prompt.map(node), '  end');
    lines.push('  subgraph B["did (behavior)"]', '    direction LR', ...events.filter((e) => !isPrompt(e)).map(node), '  end');
  } else {
    lines.push(...events.map(node));
  }
  let links = 0;
  for (const e of events) {
    const parents = e.parent_ids ?? (e.parent_id ? [e.parent_id] : []);
    for (const p of parents) {
      const from = idOf.get(p);
      if (!from) continue;
      const rel = e.parent_relations?.[p];
      const arrow = rel === 'retries' ? '-.->' : '-->';
      lines.push(`  ${from} ${arrow}${rel && rel !== 'precedes' ? `|${rel}|` : ''} ${idOf.get(e.id)}`);
      links++;
    }
  }
  const seen = harness.filter((o) => idOf.has(o.node));
  if (seen.length) {
    const keyOf = (o: HarnessObservation) => (o.detail ? `${o.directive}:${o.detail}` : o.directive);
    const hid = new Map([...new Set(seen.map(keyOf))].map((k, i) => [k, `h${i}`]));
    const tally = new Map<string, { ok: number; miss: number }>();
    for (const o of seen) {
      const t = tally.get(keyOf(o)) ?? { ok: 0, miss: 0 };
      if (o.verdict === 'followed') t.ok++; else t.miss++;
      tally.set(keyOf(o), t);
    }
    lines.push('  subgraph H["told (harness)"]', '    direction TB');
    for (const [key, id] of hid) {
      const [dir, detail] = key.split(':');
      const d = directive(dir!);
      const t = tally.get(key)!;
      lines.push(`    ${id}[${label(d?.title ?? dir, detail ? `warning ${detail}` : null, d ? d.source : null, `✓${t.ok} ✗${t.miss}`)}]:::${t.miss ? 'kIssue' : 'kHarness'}`);
    }
    lines.push('  end');
    // Forward: one ✓ edge per directive, to the first behavior that followed it (the count is on the node).
    // Back: every ✗ gets its own dashed edge from the behavior to the directive it missed.
    const ok: number[] = []; const miss: number[] = [];
    const drawn = new Set<string>();
    for (const o of seen) {
      const key = keyOf(o);
      const h = hid.get(key)!;
      const n = idOf.get(o.node)!;
      const at = o.deliveredAt ? idOf.get(o.deliveredAt) : undefined;
      if (o.verdict === 'followed') {
        if (drawn.has(key)) continue;
        drawn.add(key);
        if (at) { lines.push(`  ${at} -.->|delivers| ${h}`); links++; }
        const t = tally.get(key)!;
        lines.push(`  ${h} -->|${t.ok > 1 ? `✓ ×${t.ok}` : '✓'}| ${n}`); ok.push(links++);
      } else {
        if (at) { lines.push(`  ${at} -.->|delivers| ${h}`); links++; }
        lines.push(`  ${n} -.->|✗ not followed| ${h}`); miss.push(links++);
      }
    }
    if (ok.length) lines.push(`  linkStyle ${ok.join(',')} stroke:#16a34a`);
    if (miss.length) lines.push(`  linkStyle ${miss.join(',')} stroke:#dc2626,stroke-width:2px`);
  }
  lines.push(...CLASSES.map((c) => `  ${c}`));
  return `${lines.join('\n')}\n`;
}

/** Callers → outcomes → why (refusal reasons and spec issues on failed units). */
export function overviewMermaid(pb: PromptBehaviorAnalysis | undefined): string {
  const lines = ['flowchart LR'];
  const callers = Object.entries(pb?.taskGraphs.byCaller ?? {});
  if (!pb || callers.length === 0) {
    lines.push(`  none[${label('no caller task graphs in this window')}]:::kAct`, ...CLASSES.map((c) => `  ${c}`));
    return `${lines.join('\n')}\n`;
  }
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const outcomes: Array<[key: 'succeeded' | 'failed' | 'rejected' | 'cancelled' | 'unfinished', text: string, cls: string]> = [
    ['succeeded', 'succeeded', 'kDone'], ['failed', 'tasks failed', 'kFail'], ['rejected', 'refused', 'kFail'],
    ['cancelled', 'cancelled', 'kAct'], ['unfinished', 'unfinished', 'kAct'],
  ];
  const overall = pb.taskGraphs.overall;
  for (const [key, text, cls] of outcomes) {
    if (overall[key] > 0) lines.push(`  o_${key}[${label(text, `${overall[key]} graph(s)`)}]:::${cls}`);
  }
  callers.forEach(([caller, s], i) => {
    lines.push(`  c${i}[${label(caller, `${s.graphs} graph(s) · fail ${pct(s.failRate)}`)}]:::${s.failRate > 0 ? 'kIssue' : 'kAsked'}`);
    for (const [key] of outcomes) if (s[key] > 0) lines.push(`  c${i} -->|${s[key]}| o_${key}`);
  });
  Object.entries(overall.rejections).forEach(([code, n], i) => {
    lines.push(`  r${i}[${label(code)}]:::kErr`, `  o_rejected -->|${n}| r${i}`);
  });
  // Same evidence bar as `graph improve`, so the picture never implicates noise (lift ≈ 1).
  const t = SPEC_THRESHOLDS;
  const implicated = Object.entries(pb.issues)
    .filter(([, s]) => s.failed > 0 && (s.lift !== null ? s.lift >= t.minLift : s.failRate >= t.failRateWithoutBaseline))
    .sort((x, y) => y[1].failed - x[1].failed).slice(0, 6);
  if (implicated.length) {
    const from = overall.failed > 0 ? 'o_failed' : 'o_rejected';
    implicated.forEach(([code, s], i) => {
      if (Object.prototype.hasOwnProperty.call(overall.rejections, code)) return;
      lines.push(`  i${i}[${label(code, `${s.failed}/${s.units} failed${s.lift !== null ? ` · lift ${s.lift}` : ''}`)}]:::kIssue`, `  ${from} -.-> i${i}`);
    });
  }
  lines.push(...CLASSES.map((c) => `  ${c}`));
  return `${lines.join('\n')}\n`;
}

function htmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Self-contained page: overview plus one session's workflow. */
export function graphHtml(opts: { title: string; overview: string; focus?: { id: string; why: string; mermaid: string }; notes?: string[] }): string {
  const block = (src: string) => `<pre class="mermaid">${htmlEscape(src)}</pre>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(opts.title)}</title>
<style>
  :root { --bg: #f8fafc; --fg: #0f172a; --muted: #475569; --card: #ffffff; --line: #e2e8f0; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b1220; --fg: #e2e8f0; --muted: #94a3b8; --card: #111a2e; --line: #1e293b; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, sans-serif; }
  main { max-width: 1200px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 28px 0 8px; }
  p, li { color: var(--muted); }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; overflow-x: auto; }
  pre.mermaid { margin: 0; background: #ffffff; border-radius: 6px; padding: 8px; }
  code { font-size: 13px; }
</style>
</head>
<body>
<main>
<h1>${htmlEscape(opts.title)}</h1>
<p>Content-free: nodes carry ids, sizes, lint codes and failure classes, never prompt or answer text. Blue = asked (prompt), grey = agentctl calls, green/red = outcomes, amber = spec issues. Dashed edges are retries or implicated issues.</p>
<h2>Callers → outcomes → why</h2>
<section>${block(opts.overview)}</section>
${opts.focus ? `<h2>Workflow: <code>${htmlEscape(opts.focus.id)}</code></h2>
<p>${htmlEscape(opts.focus.why)}</p>
<section>${block(opts.focus.mermaid)}</section>` : ''}
${opts.notes?.length ? `<h2>Notes</h2><ul>${opts.notes.map((n) => `<li>${htmlEscape(n)}</li>`).join('')}</ul>` : ''}
</main>
<script type="module">
  try {
    const { default: mermaid } = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
    mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict', flowchart: { htmlLabels: true, useMaxWidth: false } });
    await mermaid.run({ querySelector: 'pre.mermaid' });
  } catch (e) {
    document.querySelectorAll('pre.mermaid').forEach((el) => { el.style.whiteSpace = 'pre'; el.style.color = '#0f172a'; });
  }
</script>
</body>
</html>
`;
}
