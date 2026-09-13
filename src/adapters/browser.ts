import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentctlHome } from '../core/agentHome.js';
import type { AdapterRequest, AdapterResult, AdapterCapabilities } from '../schema/index.js';
import type { Preset } from '../schema/agents.js';
import type { AgentAdapter, HealthStatus, InvokeOptions } from './protocol.js';
import { okResult, failResult } from './protocol.js';
import { redact } from '../core/redact.js';
import { run } from '../util/exec.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
// Playwright is an optional, user-installed extra reached via an indirect
// specifier so the compiler never requires it. Its objects are typed `any`.

const DEFAULT_CDP = 'http://127.0.0.1:9222';

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

/** argv for `open` to launch a dedicated debuggable browser instance. */
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

/**
 * Launch a dedicated, debuggable browser instance (separate profile) and wait
 * for its CDP endpoint. Used so the user never has to restart their main Comet.
 * Returns whether the endpoint is reachable afterward.
 */
export async function launchManagedBrowser(
  preset: Preset,
): Promise<{ ok: boolean; endpoint: string; detail: string; profileDir: string }> {
  const endpoint = preset.cdpEndpoint ?? DEFAULT_CDP;
  const profileDir = preset.userDataDir ?? defaultProfileDir();
  if (await waitForCdp(endpoint, 1500)) {
    return { ok: true, endpoint, profileDir, detail: 'a debuggable browser is already reachable' };
  }
  mkdirSync(profileDir, { recursive: true });
  const args = buildLaunchArgs(preset.appName, parsePort(endpoint), profileDir, 'https://www.perplexity.ai/');
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

function evidenceDir(workdir: string | null): string {
  const base = process.env.AGENTCTL_EVIDENCE_DIR ?? join(workdir ?? process.cwd(), '.agentctl', 'comet');
  const dir = join(base, String(Date.now()));
  mkdirSync(dir, { recursive: true });
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

  private endpoint(): string {
    return this.preset.cdpEndpoint ?? DEFAULT_CDP;
  }

  private notConfigured(durationMs: number, reason: string): AdapterResult {
    return failResult({ adapter: this.name, transport: this.transport, failureClass: 'not_configured', durationMs, reason });
  }

  /** Connect to a reachable debuggable browser, or auto-launch a managed one. */
  private async ensureConnected(pw: any): Promise<{ browser: any | null; reason: string }> {
    const endpoint = this.endpoint();
    try {
      return { browser: await pw.chromium.connectOverCDP(endpoint, { timeout: 3000 }), reason: '' };
    } catch {
      /* not reachable — maybe launch one */
    }
    if (!this.preset.autoLaunch) {
      return {
        browser: null,
        reason: `no browser at ${endpoint}; launch Comet/Chrome with --remote-debugging-port=${parsePort(endpoint)} (or enable autoLaunch)`,
      };
    }
    const launch = await launchManagedBrowser(this.preset);
    if (!launch.ok) return { browser: null, reason: launch.detail };
    try {
      return { browser: await pw.chromium.connectOverCDP(endpoint, { timeout: 5000 }), reason: '' };
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
        dir = evidenceDir(request.workdir);
      const screenshot = join(dir, 'screenshot.png');
      await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
      const safeUrl = new URL(page.url());
      safeUrl.search = "";
      safeUrl.hash = "";
      const url = safeUrl.toString();
      writeFileSync(join(dir, 'answer.txt'), redact(answer.text), 'utf8');
      writeFileSync(join(dir, 'url.txt'), url, 'utf8');
      writeFileSync(
        join(dir, 'meta.json'),
        JSON.stringify({ prompt: redact(request.prompt), url, partial: answer.partial, ts: new Date().toISOString() }, null, 2),
      );
      try {
        writeFileSync(join(dir, 'page.html'), redact(await page.content()), 'utf8');
      } catch {
        /* best effort */
      }

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
    const probe = async (): Promise<boolean> => {
      try {
        const browser = await pw.chromium.connectOverCDP(this.endpoint(), { timeout: 3000 });
        await browser.close().catch(() => {});
        return true;
      } catch {
        return false;
      }
    };
    if (await probe()) {
      return { available: true, detail: `CDP reachable at ${this.endpoint()}`, checkedVia: 'connectOverCDP' };
    }
    // Nothing reachable. With autoLaunch on, bring up a dedicated managed Comet
    // right here so `/agents` warms it up — the user never runs a flag by hand
    // (just logs into Perplexity once in the window that opens). Mirrors invoke().
    if (!this.preset.autoLaunch) {
      return {
        available: false,
        detail: `no browser on ${this.endpoint()} — launch ${this.preset.appName} with --remote-debugging-port=${parsePort(this.endpoint())} (or set autoLaunch)`,
        checkedVia: 'connectOverCDP',
      };
    }
    const launch = await launchManagedBrowser(this.preset);
    if (!launch.ok) {
      return { available: false, detail: launch.detail, checkedVia: 'autoLaunch' };
    }
    const ready = await probe();
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
