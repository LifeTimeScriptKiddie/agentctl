#!/usr/bin/env node
// DesktopMon invokes `node ENTRY --once --json`; no standalone package is needed.
import { Command } from 'commander';
import { configureMonitorCommand } from './command.js';
import { isEntrypoint } from '../util/entry.js';

if (isEntrypoint(import.meta.url)) {
  configureMonitorCommand(new Command().name('agentctl monitor'))
    .parseAsync(process.argv).catch((error: unknown) => {
      console.error(`agentctl monitor: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
