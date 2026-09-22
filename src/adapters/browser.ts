import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentctlHome } from '../core/agentHome.js';
import { ensurePrivateDir, writePrivateFile } from '../core/privateFs.js';
import type { AdapterRequest, AdapterResult, AdapterCapabilities } from '../schema/index.js';
import type { Preset } from '../schema/agents.js';
import type { AgentAdapter, HealthStatus, InvokeOptions } from './protocol.js';
import { okResult, failResult } from './protocol.js';
import { redact } from '../core/redact.js';
import { run } from '../util/exec.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
// Playwright is an optional, user-installed extra reached via an indirect
// specifier so the compiler never requires it. Its objects are typed `any`.

const INPUT_SELECTORS = [
  'textarea[placeholder]',
  'main textarea',
  'textarea',
  'div[contenteditable="true"]',
  '[role="textbox"]',
];
// Answer containers only. `main` is deliberately absent: before the answer
// renders it yields the page chrome ("Answer / Links / Images / Share /
// Download Comet") plus the echoed prompt, which reads as a plausible answer
// and has been captured as one. No container means no answer yet, not chrome.
const ANSWER_SELECTORS = ['.prose', '[data-testid="answer"]', 'main [class*="prose"]'];

async function loadPlaywright(): Promise<any | null> {
  try {
    const spec = 'playwright';
    return await import(spec);
  } catch {
    return null;
  }
}

export function parsePort(endpoint: string): number {
  const m = endpoint.match(/:(\d+)/);
  return m ? Number(m[1]) : 9222;
}

export function defaultProfileDir(): string {
  // Chrome-specific dir: keeps a dedicated, unlocked profile so the managed
  // instance never collides with a stray browser holding another profile's lock.
  return join(agentctlHome(), 'chrome-profile');
}

/** argv for `open` to launch a debuggable instance on an explicitly configured port. */
export function buildLaunchArgs(appName: string, port: number, userDataDir: string, url: string): string[] {
  return [
    '-na',
    appName,
    '--args',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ];
}

/**
 * argv for the managed instance: Chrome picks a free loopback port and records
 * it in `<userDataDir>/DevToolsActivePort`, so no fixed port can be pre-bound.
 */
export function buildManagedLaunchArgs(appName: string, userDataDir: string, url: string): string[] {
  return [
    '-na',
    appName,
    '--args',
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ];
}

export interface DevToolsActivePort {
  port: number;
  /** browser WebSocket path, e.g. /devtools/browser/<uuid>; null if the file has no second line. */
  browserPath: string | null;
}

/** Parse Chrome's DevToolsActivePort file: line 1 is the port, line 2 the browser WebSocket path. */
export function parseDevToolsActivePort(content: string): DevToolsActivePort | null {
  const [portLine, pathLine] = content.split(/\r?\n/);
  const text = portLine?.trim() ?? '';
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  if (port < 1 || port > 65535) return null;
  const path = pathLine?.trim() ?? '';
  return { port, browserPath: path.startsWith('/') ? path : null };
}

export function readDevToolsActivePort(profileDir: string): DevToolsActivePort | null {
  try {
    return parseDevToolsActivePort(readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8'));
  } catch {
    return null;
  }
}

export type VerifiedEndpoint = { ok: true; wsEndpoint: string } | { ok: false; reason: string };

/**
 * Check a `/json/version` body against the port file. The advertised WebSocket
 * URL must be loopback on the recorded port (and the recorded browser path, when
 * present); anything else is a different listener and is refused.
 */
export function matchDevToolsVersion(version: unknown, active: DevToolsActivePort): VerifiedEndpoint {
  const ws = (version as { webSocketDebuggerUrl?: unknown } | null)?.webSocketDebuggerUrl;
  if (typeof ws !== 'string') return { ok: false, reason: '/json/version has no webSocketDebuggerUrl' };
  let url: URL;
  try {
    url = new URL(ws);
  } catch {
    return { ok: false, reason: '/json/version has an invalid webSocketDebuggerUrl' };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    return { ok: false, reason: `refusing non-loopback DevTools endpoint ${url.host}` };
  }
  if (Number(url.port) !== active.port) {
    return {
      ok: false,
      reason: `DevTools port mismatch: DevToolsActivePort says ${active.port}, /json/version advertises ${url.port || '(none)'}`,
    };
  }
  if (active.browserPath && url.pathname !== active.browserPath) {
    return { ok: false, reason: 'DevTools browser id does not match DevToolsActivePort' };
  }
  return { ok: true, wsEndpoint: `ws://127.0.0.1:${active.port}${url.pathname}` };
}

/** Owning uids from `lsof -Fpu` output (`u<uid>` lines). */
export function parseLsofUids(output: string): number[] {
  return output.split(/\r?\n/).filter((line) => /^u\d+$/.test(line)).map((line) => Number(line.slice(1)));
}

/**
 * The process listening on the DevTools port must be this user's, or another
 * local account could stand in for the managed browser. Skipped when lsof is
 * not installed or the platform has no uids; any other lsof failure refuses.
 */
export async function checkDevToolsListenerOwner(port: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  const uid = process.getuid?.();
  if (uid === undefined) return { ok: true };
  let outcome;
  try {
    outcome = await run('lsof', ['-nP', '-w', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpu'], { timeoutMs: 3000 });
  } catch (e) {
    return { ok: false, reason: `could not check who owns DevTools port ${port} (${e instanceof Error ? e.message : String(e)})` };
  }
  if (outcome.notFound) return { ok: true };
  const uids = parseLsofUids(outcome.stdout);
  if (uids.length === 0) {
    return { ok: false, reason: `no process owned by this user is listening on DevTools port ${port}` };
  }
  const foreign = uids.filter((u) => u !== uid);
  if (foreign.length > 0) {
    return { ok: false, reason: `DevTools port ${port} is held by another user (uid ${[...new Set(foreign)].join(', ')})` };
  }
  return { ok: true };
}

/** The managed browser's WebSocket endpoint, verified against its private profile's port file. */
export async function verifiedManagedEndpoint(profileDir: string): Promise<VerifiedEndpoint> {
  const active = readDevToolsActivePort(profileDir);
  if (!active) return { ok: false, reason: `no DevToolsActivePort in ${profileDir}` };
  const owner = await checkDevToolsListenerOwner(active.port);
  if (!owner.ok) return owner;
  let version: unknown;
  try {
    const r = await fetch(`http://127.0.0.1:${active.port}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return { ok: false, reason: `/json/version on port ${active.port} returned HTTP ${r.status}` };
    version = await r.json();
  } catch {
    return { ok: false, reason: `nothing answering on 127.0.0.1:${active.port}` };
  }
  return matchDevToolsVersion(version, active);
}

async function waitForManagedEndpoint(profileDir: string, timeoutMs: number): Promise<VerifiedEndpoint> {
  const deadline = Date.now() + timeoutMs;
  let last: VerifiedEndpoint = { ok: false, reason: 'not started' };
  while (Date.now() < deadline) {
    last = await verifiedManagedEndpoint(profileDir);
    if (last.ok) return last;
    await new Promise((res) => setTimeout(res, 600));
  }
  return last;
}

/** Poll the CDP endpoint's /json/version until it responds or times out. */
async function waitForCdp(endpoint: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 600));
  }
  return false;
}

/** Profile dir for the managed instance, created/tightened to 0700 (it holds login cookies). */
export function prepareProfileDir(preset: Preset): string {
  const profileDir = profileDirFor(preset);
  ensurePrivateDir(profileDir);
  return profileDir;
}

function profileDirFor(preset: Preset): string {
  return preset.userDataDir ?? defaultProfileDir();
}

/**
 * Launch a dedicated, debuggable browser instance (separate profile) and wait
 * for its CDP endpoint. Used so the user never has to restart their main Comet.
 * Returns whether the endpoint is reachable afterward. An explicit preset
 * `cdpEndpoint` uses that fixed port; otherwise Chrome picks the port and the
 * endpoint is verified against the profile's DevToolsActivePort file.
 */
export async function launchManagedBrowser(
  preset: Preset,
): Promise<{ ok: boolean; endpoint: string; detail: string; profileDir: string }> {
  const profileDir = prepareProfileDir(preset);
  const startUrl = 'https://www.perplexity.ai/';
  if (preset.cdpEndpoint) {
    const endpoint = preset.cdpEndpoint;
    if (await waitForCdp(endpoint, 1500)) {
      return { ok: true, endpoint, profileDir, detail: 'a debuggable browser is already reachable' };
    }
    const args = buildLaunchArgs(preset.appName, parsePort(endpoint), profileDir, startUrl);
    await run('open', args, { timeoutMs: 10000 }).catch(() => {});
    const ok = await waitForCdp(endpoint, 25000);
    return {
      ok,
      endpoint,
      profileDir,
      detail: ok
        ? `launched ${preset.appName} (profile ${profileDir})`
        : `launched ${preset.appName} but CDP did not come up at ${endpoint}`,
    };
  }
  const existing = await verifiedManagedEndpoint(profileDir);
  if (existing.ok) {
    return { ok: true, endpoint: existing.wsEndpoint, profileDir, detail: 'the managed browser is already running' };
  }
  await run('open', buildManagedLaunchArgs(preset.appName, profileDir, startUrl), { timeoutMs: 10000 }).catch(() => {});
  const ready = await waitForManagedEndpoint(profileDir, 25000);
  return ready.ok
    ? { ok: true, endpoint: ready.wsEndpoint, profileDir, detail: `launched ${preset.appName} (profile ${profileDir})` }
    : {
        ok: false,
        endpoint: '',
        profileDir,
        detail: `launched ${preset.appName} but no verified DevTools endpoint came up (${ready.reason})`,
      };
}

export async function firstVisible(page: any, selectors: string[], timeoutMs: number): Promise<any | null> {
  const per = Math.max(1000, Math.floor(timeoutMs / selectors.length));
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { state: 'visible', timeout: per });
      if (el) return el;
    } catch {
      /* try next selector */
    }
  }
  return null;
}

export async function extractAnswer(page: any): Promise<string> {
  for (const sel of ANSWER_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (el) {
        const t = (await el.innerText()).trim();
        if (t) return t;
      }
    } catch {
      /* try next */
    }
  }
  // No body-text fallback on purpose: document.body during generation is nav
  // chrome and the echoed prompt. Returning '' lets the caller keep waiting and
  // ultimately fail honestly instead of shipping chrome as the answer.
  return '';
}

/**
 * True while Perplexity is still working. It exposes a "Stop response (Esc)"
 * control for the whole generation — including the search/tool steps in the
 * middle, when the rendered text can sit unchanged for seconds. Its absence is
 * the only trustworthy completion signal; text stability is not.
 */
export async function isGenerating(page: any): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const d = (globalThis as any).document;
      const nodes = [...d.querySelectorAll('button,[role="button"]')];
      return nodes.some((b: any) => {
        const label = (b.getAttribute('aria-label') || '').toLowerCase();
        if (!label.includes('stop')) return false;
        return !!(b.offsetParent || b.getClientRects().length);
      });
    });
  } catch {
    return false;
  }
}

/**
 * Two-signal completion: the generation affordance is gone AND the text has
 * settled. Text stability alone is not completion — Perplexity pauses mid-answer
 * while it runs search or tool steps, and a pause longer than the stability
 * window used to be reported as a finished answer, silently truncating it
 * (often mid-sentence or mid-JSON) with `partial: false`.
 *
 * `stableMs` is now only the fallback for when the affordance is never seen
 * (instant answers, or a DOM change), so it is deliberately generous.
 */
export async function waitForAnswer(
  page: any,
  timeoutMs: number,
  stableMs = 8000,
  settleMs = 1500,
): Promise<{ text: string; partial: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let stableSince = Date.now();
  let sawBusy = false;
  let idleSince: number | null = null;
  while (Date.now() < deadline) {
    await page.waitForTimeout(700);
    const busy = await isGenerating(page);
    const text = await extractAnswer(page);
    if (text !== last) {
      last = text;
      stableSince = Date.now();
    }
    if (busy) {
      // Still working. A plateau here means a search step, not an answer.
      sawBusy = true;
      idleSince = null;
      continue;
    }
    if (!text) continue;
    if (sawBusy) {
      // The affordance we watched appear has now gone: authoritative. Confirm
      // over a short window so a flicker between steps cannot end the wait.
      if (idleSince === null) idleSince = Date.now();
      if (Date.now() - idleSince >= settleMs && Date.now() - stableSince >= settleMs) {
        return { text, partial: false };
      }
      continue;
    }
    if (Date.now() - stableSince >= stableMs) return { text, partial: false };
  }
  return { text: last, partial: true };
}

/** Per-capture evidence dir: `$AGENTCTL_EVIDENCE_DIR`, else `$AGENTCTL_HOME/evidence/comet` (0700, outside any repo). */
export function evidenceDir(): string {
  const configured = process.env.AGENTCTL_EVIDENCE_DIR;
  const base = configured ?? join(agentctlHome(), 'evidence', 'comet');
  if (!configured) {
    ensurePrivateDir(join(agentctlHome(), 'evidence'));
    ensurePrivateDir(base);
  }
  const dir = join(base, String(Date.now()));
  ensurePrivateDir(dir);
  return dir;
}

/** Screenshot plus redacted text evidence for one answer. Returns the evidence dir. */
export async function captureEvidence(
  page: any,
  prompt: string,
  answer: { text: string; partial: boolean },
): Promise<string> {
  const dir = evidenceDir();
  const screenshot = join(dir, 'screenshot.png');
  await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
  const safeUrl = new URL(page.url());
  safeUrl.search = "";
  safeUrl.hash = "";
  const url = redact(safeUrl.toString());
  writePrivateFile(join(dir, 'answer.txt'), redact(answer.text));
  writePrivateFile(join(dir, 'url.txt'), url);
  writePrivateFile(
    join(dir, 'meta.json'),
    JSON.stringify({ prompt: redact(prompt), url, partial: answer.partial, ts: new Date().toISOString() }, null, 2),
  );
  try {
    writePrivateFile(join(dir, 'page.html'), redact(await page.content()));
  } catch {
    /* best effort */
  }
  return dir;
}

/**
 * Comet/Perplexity adapter. Attaches to a running Comet/Chrome over CDP
 * (preserving the live login), submits the prompt to Perplexity, and captures
 * the answer + a screenshot as evidence. Read-only/evidence role. Every failure
 * path fails closed (never throws); the loop never depends on it.
 */
export class BrowserAdapter implements AgentAdapter {
  readonly transport = 'browser' as const;
  readonly name: string;

  constructor(private readonly preset: Preset) {
    this.name = preset.name;
  }

  private notConfigured(durationMs: number, reason: string): AdapterResult {
    return failResult({ adapter: this.name, transport: this.transport, failureClass: 'not_configured', durationMs, reason });
  }

  /**
   * Where to attach: an explicitly configured `cdpEndpoint` as-is, otherwise the
   * managed instance, but only once its /json/version matches DevToolsActivePort.
   */
  private async attachTarget(): Promise<{ endpoint: string | null; reason: string }> {
    if (this.preset.cdpEndpoint) return { endpoint: this.preset.cdpEndpoint, reason: '' };
    const profileDir = profileDirFor(this.preset);
    if (existsSync(profileDir)) ensurePrivateDir(profileDir);
    const verified = await verifiedManagedEndpoint(profileDir);
    return verified.ok ? { endpoint: verified.wsEndpoint, reason: '' } : { endpoint: null, reason: verified.reason };
  }

  private unreachableHint(reason: string): string {
    if (this.preset.cdpEndpoint) {
      const endpoint = this.preset.cdpEndpoint;
      return `no browser at ${endpoint}; launch Comet/Chrome with --remote-debugging-port=${parsePort(endpoint)} (or enable autoLaunch)`;
    }
    return `no managed browser (${reason}); run \`agentctl comet setup\` (or enable autoLaunch)`;
  }

  /** Connect to a reachable debuggable browser, or auto-launch a managed one. */
  private async ensureConnected(pw: any): Promise<{ browser: any | null; reason: string }> {
    const target = await this.attachTarget();
    if (target.endpoint) {
      try {
        return { browser: await pw.chromium.connectOverCDP(target.endpoint, { timeout: 3000 }), reason: '' };
      } catch {
        /* not reachable — maybe launch one */
      }
    }
    if (!this.preset.autoLaunch) {
      return { browser: null, reason: this.unreachableHint(target.reason) };
    }
    const launch = await launchManagedBrowser(this.preset);
    if (!launch.ok) return { browser: null, reason: launch.detail };
    try {
      return { browser: await pw.chromium.connectOverCDP(launch.endpoint, { timeout: 5000 }), reason: '' };
    } catch (e) {
      return { browser: null, reason: `attached browser launched but connect failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async invoke(request: AdapterRequest, opts: InvokeOptions = {}): Promise<AdapterResult> {
    const start = Date.now();
    if (opts.signal?.aborted) {
      return failResult({
        adapter: this.name, transport: this.transport, failureClass: 'transport_error',
        durationMs: 0, reason: 'cancelled',
      });
    }
    const pw = await loadPlaywright();
    if (!pw) {
      return this.notConfigured(
        Date.now() - start,
        'playwright is not installed (optional [browser] extra); run `npm i playwright`',
      );
    }

    const conn = await this.ensureConnected(pw);
    if (!conn.browser) {
      return this.notConfigured(Date.now() - start, conn.reason);
    }
    const browser = conn.browser;
    const abort = () => { void browser.close().catch(() => {}); };
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) abort();

    try {
      // Always open a FRESH page so we never scrape a stale answer from an
      // existing Perplexity thread. (Reusing an open tab captured prior content
      // before the new answer rendered.)
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = await context.newPage();
      await page.goto('https://www.perplexity.ai/', { waitUntil: 'domcontentloaded', timeout: 30000 });

      const input = await firstVisible(page, INPUT_SELECTORS, 15000);
      if (!input) {
        await browser.close().catch(() => {});
        return failResult({
          adapter: this.name, transport: this.transport, failureClass: 'parse_error',
          durationMs: Date.now() - start,
          reason: 'could not find the Perplexity input box (DOM may have changed, or an auth wall is showing)',
        });
      }

      await input.click();
      try {
        await input.fill(request.prompt);
      } catch {
        await input.type(request.prompt);
      }
      await page.keyboard.press('Enter');

      // Wait for the new search thread to open before reading the answer, so we
      // don't capture the home/empty state or a previous thread.
      await page.waitForURL(/\/search\//, { timeout: 20000 }).catch(() => {});

      const remaining = Math.max(5000, request.timeoutSeconds * 1000 - (Date.now() - start));
      const answer = await waitForAnswer(page, remaining);

      let dir: string | undefined;
      if (process.env.AGENTCTL_CAPTURE_EVIDENCE === '1') {
        dir = await captureEvidence(page, request.prompt, answer);
      }

      // close our temp page, then disconnect. close() on a CDP-attached browser
      // disconnects Playwright; it does NOT close the user's real Comet/Chrome.
      await page.close().catch(() => {});
      await browser.close().catch(() => {});

      if (!answer.text) {
        return failResult({
          adapter: this.name, transport: this.transport, failureClass: 'parse_error',
          durationMs: Date.now() - start, reason: 'no answer text captured', rawPath: dir,
        });
      }
      if (answer.partial) {
        return failResult({
          adapter: this.name, transport: this.transport, failureClass: 'timeout',
          durationMs: Date.now() - start,
          reason: 'answer did not stabilize before timeout', rawPath: dir,
        });
      }
      return okResult({
        adapter: this.name, transport: this.transport,
        normalizedText: redact(answer.text), durationMs: Date.now() - start, rawPath: dir,
      });
    } catch (e) {
      await browser.close().catch(() => {});
      return failResult({
        adapter: this.name, transport: this.transport, failureClass: 'transport_error',
        durationMs: Date.now() - start,
        reason: opts.signal?.aborted ? 'cancelled' : e instanceof Error ? e.message : String(e),
      });
    } finally {
      opts.signal?.removeEventListener('abort', abort);
    }
  }

  async healthcheck(): Promise<HealthStatus> {
    const pw = await loadPlaywright();
    if (!pw) {
      return { available: false, detail: 'playwright not installed (optional [browser] extra)', checkedVia: 'import probe' };
    }
    const probe = async (): Promise<{ endpoint: string | null; reason: string }> => {
      const target = await this.attachTarget();
      if (!target.endpoint) return target;
      try {
        const browser = await pw.chromium.connectOverCDP(target.endpoint, { timeout: 3000 });
        await browser.close().catch(() => {});
        return target;
      } catch {
        return { endpoint: null, reason: `connect to ${target.endpoint} failed` };
      }
    };
    const first = await probe();
    if (first.endpoint) {
      return { available: true, detail: `CDP reachable at ${first.endpoint}`, checkedVia: 'connectOverCDP' };
    }
    // Nothing reachable. With autoLaunch on, bring up a dedicated managed Comet
    // right here so `/agents` warms it up — the user never runs a flag by hand
    // (just logs into Perplexity once in the window that opens). Mirrors invoke().
    if (!this.preset.autoLaunch) {
      return {
        available: false,
        detail: this.preset.cdpEndpoint
          ? `no browser on ${this.preset.cdpEndpoint} — launch ${this.preset.appName} with --remote-debugging-port=${parsePort(this.preset.cdpEndpoint)} (or set autoLaunch)`
          : this.unreachableHint(first.reason),
        checkedVia: 'connectOverCDP',
      };
    }
    const launch = await launchManagedBrowser(this.preset);
    if (!launch.ok) {
      return { available: false, detail: launch.detail, checkedVia: 'autoLaunch' };
    }
    const ready = (await probe()).endpoint !== null;
    return {
      available: ready,
      detail: ready
        ? `${launch.detail} — log into Perplexity once in that window if prompted`
        : `${launch.detail} but CDP connect failed`,
      checkedVia: 'autoLaunch',
    };
  }

  capabilities(): AdapterCapabilities {
    return this.preset.capabilities;
  }
}
