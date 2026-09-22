import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { trustConfig, untrustConfig, trustedConfigsPath } from '../core/configTrust.js';

export function registerConfigCommands(program: Command): void {
  const config = program.command('config').description('manage trust for repo-local agents.yaml files');

  config.command('trust')
    .description('print a local agents.yaml and record its hash so agentctl will load it')
    .argument('[path]', 'config file to trust', './agents.yaml')
    .action((path: string) => {
      if (!existsSync(path)) {
        console.error(`no config at ${path}`);
        process.exitCode = 2;
        return;
      }
      try {
        const trusted = trustConfig(path);
        console.log(trusted.content.endsWith('\n') ? trusted.content.slice(0, -1) : trusted.content);
        console.log(`\ntrusted ${trusted.path} (sha256 ${trusted.sha256}) in ${trustedConfigsPath()}`);
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
