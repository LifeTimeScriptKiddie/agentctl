import { execFileSync, spawnSync } from 'node:child_process';

/** Read system clipboard as UTF-8 text. */
export function readClipboard(): string {
  try {
    if (process.platform === 'darwin') {
      return execFileSync('pbpaste', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    }
    if (process.platform === 'win32') {
      const r = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', '[Console]::Out.Write((Get-Clipboard -Raw).ToString())'],
        { encoding: 'utf8' },
      );
      return r.stdout ?? '';
    }
    try {
      return execFileSync('xclip', ['-selection', 'clipboard', '-o'], { encoding: 'utf8' });
    } catch {
      return execFileSync('xsel', ['--clipboard', '--output'], { encoding: 'utf8' });
    }
  } catch {
    return '';
  }
}

/** Write UTF-8 text to system clipboard. */
export function writeClipboard(text: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!text) return false;
  try {
    if (platform === 'darwin') {
      const r = spawnSync('pbcopy', { input: text, encoding: 'utf8' });
      return !r.error && r.status === 0;
    }
    if (platform === 'win32') {
      const r = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', 'Set-Clipboard -Value $env:CLIPBOARD_PASTE'],
        { encoding: 'utf8', env: { ...process.env, CLIPBOARD_PASTE: text } },
      );
      return r.status === 0;
    }
    const xclip = spawnSync('xclip', ['-selection', 'clipboard'], { input: text, encoding: 'utf8' });
    if (!xclip.error && xclip.status === 0) return true;
    const xsel = spawnSync('xsel', ['--clipboard', '--input'], { input: text, encoding: 'utf8' });
    return !xsel.error && xsel.status === 0;
  } catch {
    return false;
  }
}

/** Collapse clipboard text to a single input line. */
export function clipboardToInputLine(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}
