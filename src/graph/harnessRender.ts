import { CLASSES, label } from './render.js';
import type { DirectiveDigest, HarnessDigestion } from './harness.js';

/**
 * Pictures of harness digestion (content-free):
 * - `harnessFlowMermaid`: forward. Harness source → directive → the model that
 *   read it (edge: ✓ followed / ✗ not followed) → the runs it fed (ok / failed).
 * - `harnessBackMermaid`: reverse, drawn right to left. Failed runs and
 *   deviations → the directive not followed → its harness source → the file to
 *   edit. Failed runs no directive explains point at lanes or task content.
 * - `harnessHtml`: both views with a toggle, the tables, and one session's
 *   workflow with its harness lane.
 */

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);

function directiveClass(d: DirectiveDigest): string {
  if (d.check === null) return 'kBlind';
  if (d.applicable === 0) return 'kAct';
  if (d.notFollowed > 0) return d.strength === 'must' ? 'kErr' : 'kIssue';
  return 'kOk';
}

function directiveLabel(d: DirectiveDigest): string {
  const state = d.check === null ? 'blind spot: needs content'
    : d.applicable === 0 ? 'not exercised yet'
      : `✓${d.followed} ✗${d.notFollowed} · ${pct(d.followRate)}`;
  return label(d.title, d.strength, state);
}

export function harnessFlowMermaid(d: HarnessDigestion): string {
  const lines = ['flowchart LR'];
  const did = new Map(d.directives.map((x, i) => [x.id, `d${i}`]));
  const models = Object.keys(d.readers).sort();
  const mid = new Map(models.map((m, i) => [m, `m${i}`]));
  d.sources.forEach((s, i) => {
    lines.push(`  subgraph s${i}[${label(s.title, `${s.audience} · read ${s.delivered}×`)}]`, '    direction TB');
    for (const x of d.directives.filter((x) => x.source === s.id)) lines.push(`    ${did.get(x.id)}[${directiveLabel(x)}]:::${directiveClass(x)}`);
    lines.push('  end');
  });
  if (models.length === 0) {
    lines.push(`  none[${label('no model behavior observed in this window')}]:::kAct`, ...CLASSES.map((c) => `  ${c}`));
    return `${lines.join('\n')}\n`;
  }
  for (const m of models) {
    const r = d.readers[m]!;
    lines.push(`  ${mid.get(m)}[${label(m, `✓${r.followed} ✗${r.notFollowed} · ${pct(r.followRate)}`)}]:::${r.notFollowed ? 'kIssue' : 'kAsked'}`);
  }
  const anyRuns = models.some((m) => d.readers[m]!.runs > 0);
  if (anyRuns) {
    lines.push(`  runOk[${label('runs succeeded')}]:::kDone`, `  runFail[${label('runs failed or refused')}]:::kFail`);
  }
  let links = 0;
  const ok: number[] = []; const miss: number[] = [];
  for (const x of d.directives) {
    for (const [m, t] of Object.entries(x.byModel)) {
      lines.push(`  ${did.get(x.id)} -->|${label(`✓${t.followed} ✗${t.notFollowed}`)}| ${mid.get(m)}`);
      (t.notFollowed ? miss : ok).push(links++);
    }
  }
  for (const m of models) {
    const r = d.readers[m]!;
    if (r.runs - r.failed > 0) { lines.push(`  ${mid.get(m)} -->|${r.runs - r.failed}| runOk`); links++; }
    if (r.failed > 0) { lines.push(`  ${mid.get(m)} -->|${r.failed}| runFail`); miss.push(links++); }
  }
  if (ok.length) lines.push(`  linkStyle ${ok.join(',')} stroke:#16a34a`);
  if (miss.length) lines.push(`  linkStyle ${miss.join(',')} stroke:#dc2626,stroke-width:2px`);
  lines.push(...CLASSES.map((c) => `  ${c}`));
  return `${lines.join('\n')}\n`;
}

export function harnessBackMermaid(d: HarnessDigestion): string {
  const lines = ['flowchart RL'];
  const failedRuns = d.back.length;
  const missed = d.directives.filter((x) => x.notFollowed > 0);
  const unexplained = d.back.filter((b) => b.notFollowed.length === 0).length;
  if (failedRuns === 0 && missed.length === 0) {
    lines.push(`  none[${label('nothing to trace back: no failed runs and no directive left unfollowed')}]:::kDone`, ...CLASSES.map((c) => `  ${c}`));
    return `${lines.join('\n')}\n`;
  }
  if (failedRuns) lines.push(`  fail[${label('failed or refused runs', `${failedRuns} run(s)`)}]:::kFail`);
  const devTotal = missed.reduce((n, x) => n + x.notFollowed, 0);
  if (devTotal) lines.push(`  dev[${label('not followed', `${devTotal} time(s)`)}]:::kIssue`);
  const srcId = new Map<string, string>();
  missed.forEach((x, i) => {
    lines.push(`  b${i}[${label(x.title, `“${x.says.length > 70 ? `${x.says.slice(0, 69)}…` : x.says}”`, `${x.strength}`)}]:::${x.strength === 'must' ? 'kErr' : 'kIssue'}`);
    const failedIn = d.back.filter((b) => b.notFollowed.some((n) => n.directive === x.id)).length;
    if (failedIn) lines.push(`  fail -->|${label(`in ${failedIn} failed run(s)`)}| b${i}`);
    lines.push(`  dev -->|${x.notFollowed}| b${i}`);
    const s = d.sources.find((y) => y.id === x.source)!;
    if (!srcId.has(s.id)) {
      const id = `s${srcId.size}`;
      srcId.set(s.id, id);
      lines.push(`  ${id}[${label(s.title)}]:::kHarness`, `  ${id} --> f${id}[${label('edit', s.edit)}]:::kAct`);
    }
    lines.push(`  b${i} -->|said by| ${srcId.get(s.id)}`);
  });
  if (unexplained) {
    // Failures no directive explains: a lane problem, or something the harness never told the model.
    const reasons = new Map<string, number>();
    for (const b of d.back) if (b.notFollowed.length === 0) reasons.set(b.reason, (reasons.get(b.reason) ?? 0) + 1);
    lines.push(`  gap[${label('no directive covers this', 'lane problem or harness gap')}]:::kBlind`);
    [...reasons].forEach(([reason, n], i) => {
      lines.push(`  g${i}[${label(reason)}]:::kErr`, `  fail -->|${label(`${n} run(s)`)}| g${i}`, `  g${i} --> gap`);
    });
  }
  lines.push(...CLASSES.map((c) => `  ${c}`));
  return `${lines.join('\n')}\n`;
}

function htmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Markdown lines for summary.md. */
export function harnessSummaryLines(d: HarnessDigestion): string[] {
  const exercised = d.directives.filter((x) => x.applicable > 0);
  const lines = [
    '## Harness digestion (how models take in what agentctl tells them)',
    '',
    'Flow: harness source → directive → model that read it (✓ followed / ✗ not followed) → runs. Back: failed runs → directive not followed → source → file to edit. Pictures: `harness.html`.',
    '',
    `- Observations: ${d.observations}; harness versions seen: ${d.versions.join(', ') || 'none recorded'}`,
    ...d.sources.map((s) => `- ${s.title}: read ${s.delivered}× by ${s.readers.join(', ') || 'nobody in this window'}`),
  ];
  if (exercised.length) {
    lines.push('', '| Directive | Source | Must/should | ✓ | ✗ | Follow rate | Failed runs after ✓ / ✗ |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const x of exercised) {
      lines.push(`| ${x.title} | ${x.source} | ${x.strength} | ${x.followed} | ${x.notFollowed} | ${pct(x.followRate)} | ${x.after.followed.failed}/${x.after.followed.runs} · ${x.after.notFollowed.failed}/${x.after.notFollowed.runs} |`);
    }
  }
  const traced = d.back.filter((b) => b.notFollowed.length);
  lines.push('', `- Failed runs: ${d.back.length}; traced to a directive: ${traced.length}; not a harness-reading problem: ${d.back.length - traced.length}`);
  lines.push(`- Blind spots (need content to check): ${d.blindSpots.join(', ')}`);
  return lines;
}

/** Self-contained page: flow and back views with a toggle, tables, and a focus workflow. */
export function harnessHtml(opts: {
  title: string; digestion: HarnessDigestion; flow: string; back: string;
  focus?: { id: string; why: string; mermaid: string };
}): string {
  const d = opts.digestion;
  const block = (src: string) => `<pre class="mermaid">${htmlEscape(src)}</pre>`;
  const row = (cells: Array<string | number>) => `<tr>${cells.map((c) => `<td>${htmlEscape(String(c))}</td>`).join('')}</tr>`;
  const table = (head: string[], rows: string[]) => (rows.length
    ? `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${htmlEscape(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : '<p>None in this window.</p>');
  const readers = Object.entries(d.readers).sort((a, b) => b[1].applicable - a[1].applicable)
    .map(([m, r]) => row([m, r.followed, r.notFollowed, pct(r.followRate), r.runs, r.failed]));
  const directives = d.directives.map((x) => row([
    x.title, x.source, x.strength, `“${x.says}”`,
    x.check ?? 'blind spot', x.applicable ? `${x.followed} / ${x.notFollowed}` : '—', pct(x.followRate),
    x.applicable ? `${x.after.followed.failed}/${x.after.followed.runs} · ${x.after.notFollowed.failed}/${x.after.notFollowed.runs}` : '—',
  ]));
  const back = d.back.map((b) => row([b.run, b.outcome, b.reason,
    b.notFollowed.length ? b.notFollowed.map((n) => `${n.directive}${n.detail ? `:${n.detail}` : ''} (${n.model})`).join('; ') : 'none: lane problem or harness gap']));
  const sources = d.sources.map((s) => row([s.title, s.audience, s.delivered, s.readers.join(', ') || '—', s.delivery, s.edit]));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness digestion</title>
<style>
  :root { --bg: #f8fafc; --fg: #0f172a; --muted: #475569; --card: #ffffff; --line: #e2e8f0; --accent: #7c3aed; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b1220; --fg: #e2e8f0; --muted: #94a3b8; --card: #111a2e; --line: #1e293b; --accent: #a78bfa; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, sans-serif; }
  main { max-width: 1200px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 28px 0 8px; }
  p, li { color: var(--muted); }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; overflow-x: auto; }
  pre.mermaid { margin: 0; background: #ffffff; border-radius: 6px; padding: 8px; }
  .toggle { display: flex; gap: 8px; margin: 16px 0 8px; flex-wrap: wrap; }
  .toggle button { font: inherit; padding: 6px 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
  .toggle button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .view[hidden] { display: none; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  code { font-size: 13px; }
</style>
</head>
<body>
<main>
<h1>${htmlEscape(opts.title)}</h1>
<p>How the models agentctl talks to take in its harness. <b>Flow</b> follows each harness line forward: where it is written, which model read it, whether its behavior followed it, and how the run ended. <b>Back</b> starts from failures and deviations and walks back to the line that was not followed and the file to edit. Content-free: verdicts come from lint codes, decision kinds and failure classes, never from prompt or answer text. ${d.observations} observation(s); harness version(s): ${htmlEscape(d.versions.join(', ') || 'none recorded')}.</p>
<div class="toggle" role="group" aria-label="Direction">
  <button type="button" data-view="flow" aria-pressed="true">Flow: harness → model → outcome</button>
  <button type="button" data-view="back" aria-pressed="false">Back: outcome → harness → file</button>
</div>
<section class="view" id="view-flow">${block(opts.flow)}</section>
<section class="view" id="view-back">${block(opts.back)}</section>
<p>Green edge: followed. Red edge: not followed (or a failed run). Violet: harness text. Dashed grey: a directive the graph cannot check without reading content (blind spot).</p>
<h2>Readers</h2>
<section>${table(['Model', '✓ followed', '✗ not followed', 'Follow rate', 'Runs', 'Failed runs'], readers)}</section>
<h2>Directives</h2>
<section>${table(['Directive', 'Source', 'Must/should', 'The harness says', 'Checked by', '✓ / ✗', 'Follow rate', 'Failed runs after ✓ · ✗'], directives)}</section>
<h2>Failed runs, traced back</h2>
<section>${table(['Run', 'Outcome', 'Reason', 'Not followed (reader)'], back)}</section>
<h2>Harness sources</h2>
<section>${table(['Source', 'Audience', 'Read', 'Readers', 'When', 'Edit'], sources)}</section>
${opts.focus ? `<h2>Session: <code>${htmlEscape(opts.focus.id)}</code></h2>
<p>${htmlEscape(opts.focus.why)} The "told (harness)" lane shows the directives this session's models read: a green ✓ edge runs forward to behavior that followed, a red dashed ✗ edge runs back from behavior that did not.</p>
<section>${block(opts.focus.mermaid)}</section>` : ''}
<p>${d.versions.length > 1 ? 'Several harness versions are pooled here; compare them with `agentctl graph compare`. ' : ''}Every session's workflow with its harness lane is in <code>workflows/&lt;id&gt;.mmd</code>; the prompt ↔ behavior overview is in <a href="graph.html">graph.html</a>.</p>
</main>
<script type="module">
  const show = (name) => {
    document.querySelectorAll('.toggle button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === name)));
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + name; });
  };
  document.querySelectorAll('.toggle button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  try {
    const { default: mermaid } = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
    mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict', flowchart: { htmlLabels: true, useMaxWidth: false } });
    await mermaid.run({ querySelector: 'pre.mermaid' });
  } catch (e) {
    document.querySelectorAll('pre.mermaid').forEach((el) => { el.style.whiteSpace = 'pre'; el.style.color = '#0f172a'; });
  }
  show('flow'); // hide the back view only after both diagrams were laid out while visible
</script>
</body>
</html>
`;
}
