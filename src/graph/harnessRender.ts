import { CLASSES, htmlEscape, label, mermaidBlock, pageHtml } from './render.js';
import { HARNESS_MIN_SAMPLES, PASS_K, type DirectiveDigest, type HarnessDigestion, type Tally } from './harness.js';

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
/** "85% (72–93%)", or "85% (n<3)" when there are too few checks to trust the rate. */
const rateText = (t: Tally) => (t.followRate === null ? '—'
  : `${pct(t.followRate)} ${t.enough && t.ci95 ? `(${Math.round(t.ci95[0] * 100)}–${Math.round(t.ci95[1] * 100)}%)` : `(n<${HARNESS_MIN_SAMPLES})`}`);

function directiveClass(d: DirectiveDigest): string {
  if (d.check === null) return 'kBlind';
  if (d.applicable === 0) return 'kAct';
  // Too few checks: shown, never colored as a problem.
  if (d.notFollowed > 0) return !d.enough ? 'kAct' : d.strength === 'must' ? 'kErr' : 'kIssue';
  return 'kOk';
}

function directiveLabel(d: DirectiveDigest): string {
  const state = d.check === null ? 'blind spot: needs content'
    : d.applicable === 0 ? 'not exercised yet'
      : `✓${d.followed} ✗${d.notFollowed} · ${rateText(d)}`;
  return label(d.title, d.strength, state, d.passAllK !== null ? `all ${PASS_K} in a row: ${pct(d.passAllK)}` : null);
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
    lines.push(`  ${mid.get(m)}[${label(m, `✓${r.followed} ✗${r.notFollowed} · ${rateText(r)}`)}]:::${r.notFollowed && r.enough ? 'kIssue' : 'kAsked'}`);
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
      if (t.notFollowed && t.enough) miss.push(links); else if (!t.notFollowed) ok.push(links);
      links++;
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
  const cov = d.coverage;
  if (failedRuns) lines.push(`  fail[${label('failed or refused runs', `${failedRuns} run(s) · ${cov.explained} explained by a directive`)}]:::kFail`);
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
      const candidate = cov.candidates.includes(reason) ? 'recurring: candidate new directive' : null;
      lines.push(`  g${i}[${label(reason, candidate)}]:::kErr`, `  fail -->|${label(`${n} run(s)`)}| g${i}`, `  g${i} --> gap`);
    });
  }
  lines.push(...CLASSES.map((c) => `  ${c}`));
  return `${lines.join('\n')}\n`;
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
    lines.push('', `| Directive | Source | Must/should | ✓ | ✗ | Follow rate (95% CI) | All ${PASS_K} in a row | Failed runs after ✓ / ✗ |`, '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const x of exercised) {
      lines.push(`| ${x.title} | ${x.source} | ${x.strength} | ${x.followed} | ${x.notFollowed} | ${rateText(x)} | ${pct(x.passAllK)} | ${x.after.followed.failed}/${x.after.followed.runs} · ${x.after.notFollowed.failed}/${x.after.notFollowed.runs} |`);
    }
    lines.push('', `Rates under ${HARNESS_MIN_SAMPLES} checks are shown but not flagged. ${d.caveats.join(' ')}`);
  }
  const c = d.coverage;
  lines.push('', `- Coverage: ${c.failedRuns} failed run(s), ${c.explained} explained by a directive not followed (${pct(c.explainedRate)}), ${c.unexplained} not explained${Object.keys(c.gaps).length ? ` (${Object.entries(c.gaps).map(([r, n]) => `${r} ${n}`).join(', ')})` : ''}`);
  if (c.candidates.length) lines.push(`- Candidate new directives (a reason no directive covers, in 2+ runs): ${c.candidates.join(', ')}`);
  const versions = Object.entries(d.sourceVersions).filter(([, v]) => v.length > 1);
  if (versions.length) lines.push(`- Sources seen in more than one version: ${versions.map(([src, v]) => `${src} (${v.join(', ')})`).join('; ')}`);
  lines.push(`- Blind spots (need content to check): ${d.blindSpots.join(', ')}`);
  return lines;
}

/** Self-contained page: flow and back views with a toggle, tables, and a focus workflow. */
export function harnessHtml(opts: {
  title: string; digestion: HarnessDigestion; flow: string; back: string;
  focus?: { id: string; why: string; mermaid: string };
}): string {
  const d = opts.digestion;
  const row = (cells: Array<string | number>) => `<tr>${cells.map((c) => `<td>${htmlEscape(String(c))}</td>`).join('')}</tr>`;
  const table = (head: string[], rows: string[]) => (rows.length
    ? `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${htmlEscape(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : '<p>None in this window.</p>');
  const readers = Object.entries(d.readers).sort((a, b) => b[1].applicable - a[1].applicable)
    .map(([m, r]) => row([m, r.followed, r.notFollowed, rateText(r), r.runs, r.failed]));
  const directives = d.directives.map((x) => row([
    x.title, x.source, x.strength, `“${x.says}”`,
    x.check ?? 'blind spot', x.applicable ? `${x.followed} / ${x.notFollowed}` : '—', rateText(x), pct(x.passAllK),
    x.applicable ? `${x.after.followed.failed}/${x.after.followed.runs} · ${x.after.notFollowed.failed}/${x.after.notFollowed.runs}` : '—',
  ]));
  const back = d.back.map((b) => row([b.run, b.outcome, b.reason,
    b.notFollowed.length ? b.notFollowed.map((n) => `${n.directive}${n.detail ? `:${n.detail}` : ''} (${n.model})`).join('; ') : 'none: lane problem or harness gap']));
  const sources = d.sources.map((s) => row([s.title, s.audience, s.delivered, s.readers.join(', ') || '—', s.delivery,
    (d.sourceVersions[s.id] ?? []).join(', ') || 'not recorded', s.edit]));
  const c = d.coverage;
  const coverage = `${c.failedRuns} failed run(s): ${c.explained} explained by a directive not followed (${pct(c.explainedRate)}), ${c.unexplained} not explained`
    + `${Object.keys(c.gaps).length ? ` — ${Object.entries(c.gaps).map(([r, n]) => `${r}: ${n}`).join(', ')}` : ''}.`
    + `${c.candidates.length ? ` Candidate new directives (in 2+ runs): ${c.candidates.join(', ')}.` : ''}`;
  return pageHtml({
    title: 'Harness digestion',
    css: `  .toggle { display: flex; gap: 8px; margin: 16px 0 8px; flex-wrap: wrap; }
  .toggle button { font: inherit; padding: 6px 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
  .toggle button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .view[hidden] { display: none; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }`,
    body: `<h1>${htmlEscape(opts.title)}</h1>
<p>How the models agentctl talks to take in its harness. <b>Flow</b> follows each harness line forward: where it is written, which model read it, whether its behavior followed it, and how the run ended. <b>Back</b> starts from failures and deviations and walks back to the line that was not followed and the file to edit. Content-free: verdicts come from lint codes, decision kinds and failure classes, never from prompt or answer text. ${d.observations} observation(s); harness version(s): ${htmlEscape(d.versions.join(', ') || 'none recorded')}.</p>
<div class="toggle" role="group" aria-label="Direction">
  <button type="button" data-view="flow" aria-pressed="true">Flow: harness → model → outcome</button>
  <button type="button" data-view="back" aria-pressed="false">Back: outcome → harness → file</button>
</div>
<section class="view" id="view-flow">${mermaidBlock(opts.flow)}</section>
<section class="view" id="view-back">${mermaidBlock(opts.back)}</section>
<p>Green edge: followed. Red edge: not followed (or a failed run). Violet: harness text. Dashed grey: a directive the graph cannot check without reading content (blind spot).</p>
<h2>Readers</h2>
<section>${table(['Model', '✓ followed', '✗ not followed', 'Follow rate', 'Runs', 'Failed runs'], readers)}</section>
<h2>Directives</h2>
<section>${table(['Directive', 'Source', 'Must/should', 'The harness says', 'Checked by', '✓ / ✗', 'Follow rate (95% CI)', `All ${PASS_K} in a row`, 'Failed runs after ✓ · ✗'], directives)}</section>
<p>Rates under ${HARNESS_MIN_SAMPLES} checks are shown but not flagged. ${htmlEscape(d.caveats.join(' '))}</p>
<h2>Failed runs, traced back</h2>
<p>${htmlEscape(coverage)}</p>
<section>${table(['Run', 'Outcome', 'Reason', 'Not followed (reader)'], back)}</section>
<h2>Harness sources</h2>
<section>${table(['Source', 'Audience', 'Read', 'Readers', 'When', 'Versions seen', 'Edit'], sources)}</section>
${opts.focus ? `<h2>Session: <code>${htmlEscape(opts.focus.id)}</code></h2>
<p>${htmlEscape(opts.focus.why)} The "told (harness)" lane shows the directives this session's models read: a green ✓ edge runs forward to behavior that followed, a red dashed ✗ edge runs back from behavior that did not.</p>
<section>${mermaidBlock(opts.focus.mermaid)}</section>` : ''}
<p>${d.versions.length > 1 ? 'Several harness versions are pooled here; compare them with <code>agentctl graph compare</code>. ' : ''}Every session's workflow with its harness lane is in <code>workflows/&lt;id&gt;.mmd</code>; the prompt ↔ behavior overview is in <a href="graph.html">graph.html</a>.</p>`,
    script: `  const show = (name) => {
    document.querySelectorAll('.toggle button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === name)));
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + name; });
  };
  document.querySelectorAll('.toggle button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));`,
    // hide the back view only after both diagrams were laid out while visible
    afterRender: "  show('flow');",
  });
}
