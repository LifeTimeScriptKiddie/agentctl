import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { readConfigForTrust, trustConfig, untrustConfig, trustedConfigsPath } from '../core/configTrust.js';
import { color } from '../util/colors.js';
import { executablePathWarnings, reviewLines, stripControlChars } from './review.js';

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

export function registerConfigCommands(program: Command): void {
  const config = program.command('config').description('manage trust for repo-local agents.yaml files');

  config.command('trust')
    .description('review a local agents.yaml, then record its hash so agentctl will load it')
    .argument('[path]', 'config file to trust', './agents.yaml')
    .option('-y, --yes', 'trust without the confirmation prompt (required when stdin is not a TTY)')
    .action(async (path: string, opts: { yes?: boolean }) => {
      if (!existsSync(path)) {
        console.error(`no config at ${path}`);
        process.exitCode = 2;
        return;
      }
      try {
        const reviewed = readConfigForTrust(path);
        const shown = stripControlChars(reviewed.content.endsWith('\n') ? reviewed.content.slice(0, -1) : reviewed.content);
        for (const line of reviewLines(shown.text)) {
          console.log(line.highlight ? color.yellow(`! ${line.text}`) : `  ${line.text}`);
        }
        console.log('');
        console.log("lines marked '!' choose what agentctl runs (commandTemplate, healthProbe, environment).");
        if (shown.removed > 0) {
          console.log(color.yellow(`warning: ${shown.removed} control character(s) in the file were not displayed.`));
        }
        for (const warning of executablePathWarnings(reviewed.content, reviewed.path)) {
          console.log(color.yellow(`warning: ${warning}; trust does not cover that file.`));
        }

        if (!opts.yes) {
          if (!process.stdin.isTTY) {
            console.error(`not trusted: stdin is not a TTY; re-run with --yes to trust ${reviewed.path}`);
            process.exitCode = 2;
            return;
          }
          if (!(await askYesNo(`trust ${reviewed.path}? [y/N] `))) {
            console.error('not trusted.');
            process.exitCode = 1;
            return;
          }
        }
        const trusted = trustConfig(path, new Date(), reviewed.sha256);
        console.log(`trusted ${trusted.path} (sha256 ${trusted.sha256}) in ${trustedConfigsPath()}`);
        console.log('editing the file makes it untrusted again.');
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });

  config.command('untrust')
    .description('forget every recorded hash for a local agents.yaml')
    .argument('[path]', 'config file to untrust', './agents.yaml')
    .action((path: string) => {
      try {
        const r = untrustConfig(path);
        console.log(r.removed ? `untrusted ${r.path}` : `${r.path} was not trusted`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
