#!/usr/bin/env node
/**
 * shared_ptr: team memory for AI agents. Store, gatekeeper server, briefings,
 * knowledge base and findings. agentctl talks to it over HTTP (/v1) or by
 * running this CLI; it never imports this package.
 */
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { registerMemoryCommands } from './command.js';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
const program = new Command('shared_ptr')
  .description('team memory for AI agents: store, gatekeeper (/v1), briefings; all output is JSON')
  .version(pkg.version);
registerMemoryCommands(program);
await program.parseAsync(process.argv);
