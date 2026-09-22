import type { Command } from 'commander';
import { formatUsage, readUsage } from './ledger.js';

export function registerUsageCommand(program: Command): void {
  program.command('usage').description('persistent provider-reported token usage grouped by agent and model')
    .option('--model <name>', 'filter by exact model label')
    .option('--since <date>', 'include attempts since an ISO date or timestamp')
    .option('--format <format>', 'text | json', 'text')
    .action((options: {model?: string; since?: string; format: string}) => {
      try {
        if (!['text', 'json'].includes(options.format)) throw new Error('--format must be text or json');
        const report = readUsage(options);
        console.log(options.format === 'json' ? JSON.stringify(report, null, 2) : formatUsage(report));
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
