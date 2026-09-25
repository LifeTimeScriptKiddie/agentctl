#!/usr/bin/env node
/**
 * shared_ptr: team memory for AI agents. Store, gatekeeper server, briefings,
 * knowledge base and findings. agentctl talks to it over HTTP (/v1) or by
 * running this CLI; it never imports this package.
 *
 * With --server <url> (or SHARED_PTR_SERVER) the team commands go to that
 * gatekeeper with your token (SHARED_PTR_TOKEN); without it they use this
 * machine's store.
 */
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { registerMemoryCommands } from './command.js';
import { REMOTE_COMMANDS, registerRemoteCommands } from './remoteCommands.js';
import { resolveServerUrl } from './client.js';

/** --server from argv (either form), removed so subcommands don't see it. */
function takeServerFlag(argv: string[]): { argv: string[]; server: string | null } {
  const out = [...argv];
  const i = out.findIndex((a) => a === '--server' || a.startsWith('--server='));
  if (i < 0) return { argv: out, server: null };
  const [flag] = out.splice(i, 1);
  const value = flag!.includes('=') ? flag!.split('=').slice(1).join('=') : out.splice(i, 1)[0] ?? '';
  return { argv: out, server: value || null };
}

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
const { argv, server: flagServer } = takeServerFlag(process.argv);
const server = resolveServerUrl(flagServer);

const program = new Command('shared_ptr')
  .description('team memory for AI agents: store, gatekeeper (/v1), briefings; all output is JSON')
  .option('--server <url>', 'use this shared_ptr gatekeeper (or SHARED_PTR_SERVER); token from SHARED_PTR_TOKEN')
  .version(pkg.version);

// The MCP server works in both modes (team gatekeeper or local store).
program.command('mcp')
  .description('serve the team-memory tools over MCP stdio (Claude Code, Codex, Cursor)')
  .requiredOption('--caller <agent>', 'the agent this serves (claude, codex, cursor, pi): reads are filtered for it')
  .action(async (o: { caller: string }) => {
    const { startSharedPtrMcpStdio } = await import('./mcp.js');
    await startSharedPtrMcpStdio({ caller: o.caller, server });
  });

if (server) {
  registerRemoteCommands(program, server);
  program.on('command:*', ([name]: string[]) => {
    console.error(JSON.stringify({
      error: `'${name}' is local-only; against a server use: ${REMOTE_COMMANDS.join(', ')}. Unset SHARED_PTR_SERVER (or drop --server) to run it locally.`,
    }));
    process.exitCode = 2;
  });
} else {
  registerMemoryCommands(program);
}
await program.parseAsync(argv);
