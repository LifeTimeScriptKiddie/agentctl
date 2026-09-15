import { Command, InvalidArgumentError, Option } from 'commander';
import { collectOutput } from './collect.js';
import { runFeed, runSamples, type Collector } from './feed.js';
import { renderJson } from './render/json.js';
import { renderTable } from './render/table.js';
import { renderStatusline } from './render/statusline.js';

export interface MonitorOptions {
  once?: boolean; json?: boolean; table?: boolean; statusline?: boolean;
  feed?: string; interval?: number;
}

function parseInterval(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 3 || seconds > 3600) {
    throw new InvalidArgumentError('interval must be between 3 and 3600 seconds');
  }
  return Math.round(seconds * 1000);
}

export async function runMonitor(options: MonitorOptions, watch = false, collect: Collector = collectOutput): Promise<void> {
  if (!watch && !options.feed) {
    const output = await collect();
    process.stdout.write(options.table ? renderTable(output) : options.statusline ? renderStatusline(output) : renderJson(output));
    return;
  }
  if (watch && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('watch requires an interactive terminal; use monitor --once --json');
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  // Keep handlers registered until collection unwinds. A once-handler disappears
  // before execa's signal-exit listener runs, which can re-raise keyboard SIGINT.
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    if (options.feed) await runFeed(options.feed, options.interval ?? 5000, collect, controller.signal);
    else await runSamples(options.interval ?? 5000, collect, (output) => {
      process.stdout.write('\x1b[2J\x1b[Hagentctl watch — observed local agents (Ctrl-C to exit)\n' +
        'Family observations do not identify managed jobs; use agentctl status for run state.\n\n' + renderTable(output));
    }, controller.signal);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

/** Shared option contract for the main CLI and the DesktopMon compatibility entry. */
export function configureMonitorCommand(command: Command): Command {
  return command
    .description('observe current-user local agents and family network totals (macOS)')
    .addOption(new Option('--once', 'collect one snapshot (the default)').conflicts('feed'))
    .addOption(new Option('--json', 'schema-1 JSON snapshot (the default)').conflicts(['table', 'statusline', 'feed']))
    .addOption(new Option('--table', 'readable family observation table').conflicts(['json', 'statusline', 'feed']))
    .addOption(new Option('--statusline', 'compact family observation summary').conflicts(['json', 'table', 'feed']))
    .addOption(new Option('--feed <path>', 'continuously replace a local schema-1 JSON feed').conflicts(['once', 'json', 'table', 'statusline']))
    .addOption(new Option('--interval <seconds>', 'feed refresh interval, 3–3600 seconds').argParser(parseInterval))
    .action(async (options: MonitorOptions, cmd: Command) => {
      if (options.interval !== undefined && !options.feed) cmd.error('--interval requires --feed', { exitCode: 2 });
      await runMonitor(options);
    });
}

export function registerMonitorCommands(program: Command): void {
  configureMonitorCommand(program.command('monitor'));
  program.command('watch')
    .description('live terminal dashboard of observed local agent families (macOS)')
    .addOption(new Option('--interval <seconds>', 'refresh interval, 3–3600 seconds').argParser(parseInterval))
    .action(async (options: MonitorOptions) => runMonitor(options, true));
}
