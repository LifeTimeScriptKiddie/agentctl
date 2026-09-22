import { describe, it, expect } from 'vitest';
import { waitForAnswer, firstVisible, extractAnswer } from '../src/adapters/browser.js';

// Gated: only runs with AGENTCTL_LIVE_BROWSER=1 and a chromium binary installed
// (`npx playwright install chromium`). Validates the CDP-attach plumbing and
// the capture helpers against a throwaway Chromium — no Perplexity/login needed.
//
// Ports stay clear of 9333, a common explicit comet cdpEndpoint. Reusing it made these tests
// attach to the managed Perplexity browser instead of the throwaway one
// whenever it happened to be running, which is neither hermetic nor safe.
const RUN = process.env.AGENTCTL_LIVE_BROWSER === '1';

describe.runIf(RUN)('browser plumbing (live, gated)', () => {
  it('connects over CDP and captures stabilized answer text', async () => {
    const spec = 'playwright';
    const pw: any = await import(spec);
    const launched = await pw.chromium.launch({ args: ['--remote-debugging-port=9401'] });
    const browser = await pw.chromium.connectOverCDP('http://127.0.0.1:9401');
    try {
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      const page = await ctx.newPage();
      await page.setContent('<main><textarea></textarea><div class="prose" id="a"></div></main>');

      const input = await firstVisible(page, ['textarea'], 3000);
      expect(input).toBeTruthy();

      await page.evaluate(() => {
        const a = document.getElementById('a')!;
        let i = 0;
        const t = setInterval(() => {
          a.innerText += `word${i++} `;
          if (i > 5) clearInterval(t);
        }, 150);
      });

      const ans = await waitForAnswer(page, 8000, 1200);
      expect(ans.partial).toBe(false);
      expect(ans.text).toContain('word0');
      expect(await extractAnswer(page)).toContain('word0');
    } finally {
      await browser.close().catch(() => {});
      await launched.close().catch(() => {});
    }
  }, 30_000);

  it('does not mistake a mid-answer pause for completion', async () => {
    const spec = 'playwright';
    const pw: any = await import(spec);
    const launched = await pw.chromium.launch({ args: ['--remote-debugging-port=9402'] });
    const browser = await pw.chromium.connectOverCDP('http://127.0.0.1:9402');
    try {
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      const page = await ctx.newPage();
      // Reproduces the real failure: text arrives, then stalls for longer than
      // any stability window while the agent runs a search step, then resumes.
      // The "Stop response" control stays up throughout, as Perplexity does.
      await page.setContent(
        '<main><button aria-label="Stop response (Esc)">stop</button>' +
          '<div class="prose" id="a">{"leads":</div></main>',
      );
      await page.evaluate(() => {
        setTimeout(() => {
          document.getElementById('a')!.innerText = '{"leads":[]}';
          document.querySelector('button[aria-label*="Stop"]')!.remove();
        }, 4000);
      });

      const ans = await waitForAnswer(page, 15000, 1200);
      expect(ans.partial).toBe(false);
      // The old text-stability rule returned the truncated '{"leads":' here.
      expect(ans.text).toBe('{"leads":[]}');
      expect(JSON.parse(ans.text)).toEqual({ leads: [] });
    } finally {
      await browser.close().catch(() => {});
      await launched.close().catch(() => {});
    }
  }, 30_000);

  it('captures no answer rather than page chrome when none has rendered', async () => {
    const spec = 'playwright';
    const pw: any = await import(spec);
    const launched = await pw.chromium.launch({ args: ['--remote-debugging-port=9403'] });
    const browser = await pw.chromium.connectOverCDP('http://127.0.0.1:9403');
    try {
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      const page = await ctx.newPage();
      // The pre-answer Perplexity DOM: nav chrome under <main>, no answer
      // container. This used to be captured and returned as the answer.
      await page.setContent('<main>Answer\nLinks\nImages\nShare\nDownload Comet</main>');

      expect(await extractAnswer(page)).toBe('');
      const ans = await waitForAnswer(page, 3000, 1200);
      expect(ans.partial).toBe(true);
      expect(ans.text).toBe('');
    } finally {
      await browser.close().catch(() => {});
      await launched.close().catch(() => {});
    }
  }, 30_000);
});
