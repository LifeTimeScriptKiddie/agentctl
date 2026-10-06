import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform as osPlatform, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentctlHome } from '../core/agentHome.js';
import { quotaWaitSettings } from '../core/preferences.js';

/**
 * The OS timer that runs `agentctl jobs wake --due` while jobs are parked at a
 * usage limit. One timer for all jobs: installed when the first job parks,
 * removed by the sweep once none are left. A sweep with nothing due only reads
 * job files, so a short interval costs nothing.
 *
 *   macOS  LaunchAgent (StartInterval) — a missed interval runs on wake
 *   Linux  systemd user timer (Persistent=true), else one tagged crontab line
 */

export const LAUNCHD_LABEL = 'com.agentctl.jobs-wake';
export const SYSTEMD_UNIT = 'agentctl-jobs-wake';
export const CRON_TAG = '# agentctl-jobs-wake';

export type Mechanism = 'launchd' | 'systemd' | 'cron';

export interface ExecResult { code: number; stdout: string; stderr: string }

/** Everything the scheduler touches, injectable so tests never call launchctl or crontab. */
export interface SchedulerEnv {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  nodePath: string;
  cliPath: string;
  /** PATH for the timer: launchd and cron start with a bare one and would not find `codex`. */
  envPath: string;
  agentctlHome: string;
  intervalMinutes: number;
  exec: (file: string, args: string[], input?: string) => ExecResult;
}

export function defaultSchedulerEnv(): SchedulerEnv {
  return {
    platform: osPlatform(),
    home: homedir(),
    uid: userInfo().uid,
    nodePath: process.execPath,
    cliPath: process.env.AGENTCTL_CLI_PATH ?? fileURLToPath(new URL('../cli.js', import.meta.url)),
    envPath: process.env.PATH ?? '/usr/bin:/bin',
    agentctlHome: agentctlHome(),
    intervalMinutes: quotaWaitSettings().wakeIntervalMinutes,
    exec: (file, args, input) => {
      const r = spawnSync(file, args, { encoding: 'utf8', timeout: 15_000, ...(input !== undefined ? { input } : {}) });
      return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error?.message ?? '') };
    },
  };
}

export interface SchedulerStatus {
  installed: boolean;
  mechanism: Mechanism | null;
  path: string | null;
  intervalMinutes: number;
}

function launchdPath(env: SchedulerEnv): string {
  return join(env.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function systemdDir(env: SchedulerEnv): string {
  return join(env.home, '.config', 'systemd', 'user');
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function launchdPlist(env: SchedulerEnv): string {
  const args = [env.nodePath, env.cliPath, 'jobs', 'wake', '--due'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(env.envPath)}</string>
    <key>AGENTCTL_HOME</key><string>${xml(env.agentctlHome)}</string>
  </dict>
  <key>StartInterval</key><integer>${env.intervalMinutes * 60}</integer>
  <key>RunAtLoad</key><true/>
  <!-- woken job runners must outlive the sweep (and its own unload) -->
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${xml(join(env.agentctlHome, 'logs', 'jobs-wake.log'))}</string>
</dict>
</plist>
`;
}

/** systemd quotes: wrap in double quotes, escape backslash and quote. */
function sdQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function systemdUnits(env: SchedulerEnv): { service: string; timer: string } {
  return {
    service: `[Unit]
Description=agentctl: resume jobs parked at a usage limit

[Service]
Type=oneshot
Environment=${sdQuote(`PATH=${env.envPath}`)}
Environment=${sdQuote(`AGENTCTL_HOME=${env.agentctlHome}`)}
ExecStart=${[env.nodePath, env.cliPath, 'jobs', 'wake', '--due'].map(sdQuote).join(' ')}
KillMode=process
`,
    timer: `[Unit]
Description=agentctl: wake sweep for parked jobs

[Timer]
OnBootSec=2min
OnUnitActiveSec=${env.intervalMinutes}min
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function cronLine(env: SchedulerEnv): string {
  const cmd = [env.nodePath, env.cliPath, 'jobs', 'wake', '--due'].map(shQuote).join(' ');
  return `*/${env.intervalMinutes} * * * * PATH=${shQuote(env.envPath)} AGENTCTL_HOME=${shQuote(env.agentctlHome)} ${cmd} >/dev/null 2>&1 ${CRON_TAG}`;
}

function hasSystemdUser(env: SchedulerEnv): boolean {
  return env.exec('systemctl', ['--user', 'show-environment']).code === 0;
}

function readCrontab(env: SchedulerEnv): string {
  const r = env.exec('crontab', ['-l']);
  return r.code === 0 ? r.stdout : '';
}

export function schedulerStatus(env: SchedulerEnv = defaultSchedulerEnv()): SchedulerStatus {
  const base = { intervalMinutes: env.intervalMinutes };
  if (env.platform === 'darwin') {
    const path = launchdPath(env);
    return { ...base, installed: existsSync(path), mechanism: 'launchd', path };
  }
  const timer = join(systemdDir(env), `${SYSTEMD_UNIT}.timer`);
  if (existsSync(timer)) return { ...base, installed: true, mechanism: 'systemd', path: timer };
  if (readCrontab(env).includes(CRON_TAG)) return { ...base, installed: true, mechanism: 'cron', path: null };
  return { ...base, installed: false, mechanism: null, path: null };
}

function check(r: ExecResult, what: string): void {
  if (r.code !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
}

export function installScheduler(env: SchedulerEnv = defaultSchedulerEnv()): SchedulerStatus {
  mkdirSync(join(env.agentctlHome, 'logs'), { recursive: true, mode: 0o700 });
  if (env.platform === 'darwin') {
    const path = launchdPath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, launchdPlist(env), { mode: 0o644 });
    const domain = `gui/${env.uid}`;
    env.exec('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]); // reload if already loaded
    check(env.exec('launchctl', ['bootstrap', domain, path]), 'launchctl bootstrap');
    return schedulerStatus(env);
  }
  if (env.platform === 'linux' && hasSystemdUser(env)) {
    const dir = systemdDir(env);
    mkdirSync(dir, { recursive: true });
    const units = systemdUnits(env);
    writeFileSync(join(dir, `${SYSTEMD_UNIT}.service`), units.service);
    writeFileSync(join(dir, `${SYSTEMD_UNIT}.timer`), units.timer);
    check(env.exec('systemctl', ['--user', 'daemon-reload']), 'systemctl daemon-reload');
    check(env.exec('systemctl', ['--user', 'enable', '--now', `${SYSTEMD_UNIT}.timer`]), 'systemctl enable');
    return schedulerStatus(env);
  }
  const kept = readCrontab(env).split('\n').filter((l) => l.trim() && !l.includes(CRON_TAG));
  check(env.exec('crontab', ['-'], `${[...kept, cronLine(env)].join('\n')}\n`), 'crontab install');
  return schedulerStatus(env);
}

export function uninstallScheduler(env: SchedulerEnv = defaultSchedulerEnv()): SchedulerStatus {
  const status = schedulerStatus(env);
  if (!status.installed) return status;
  if (status.mechanism === 'launchd') {
    // Remove the file first: unloading from inside the sweep ends this process.
    unlinkSync(status.path!);
    env.exec('launchctl', ['bootout', `gui/${env.uid}/${LAUNCHD_LABEL}`]);
  } else if (status.mechanism === 'systemd') {
    env.exec('systemctl', ['--user', 'disable', '--now', `${SYSTEMD_UNIT}.timer`]);
    for (const ext of ['timer', 'service']) {
      const p = join(systemdDir(env), `${SYSTEMD_UNIT}.${ext}`);
      if (existsSync(p)) unlinkSync(p);
    }
    env.exec('systemctl', ['--user', 'daemon-reload']);
  } else {
    const kept = readCrontab(env).split('\n').filter((l) => l.trim() && !l.includes(CRON_TAG));
    check(env.exec('crontab', ['-'], kept.length ? `${kept.join('\n')}\n` : ''), 'crontab uninstall');
  }
  return schedulerStatus(env);
}

/** Install unless already installed with the same command (a moved CLI path re-installs). */
export function ensureScheduler(env: SchedulerEnv = defaultSchedulerEnv()): SchedulerStatus {
  const status = schedulerStatus(env);
  if (status.installed && status.mechanism === 'launchd'
    && readFileSync(status.path!, 'utf8') === launchdPlist(env)) return status;
  if (status.installed && status.mechanism !== 'launchd') return status;
  return installScheduler(env);
}
