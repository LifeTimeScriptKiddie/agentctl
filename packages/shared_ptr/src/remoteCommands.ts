/**
 * `shared_ptr --server <url> …` (or SHARED_PTR_SERVER): the team commands,
 * same names and options as local mode, sent to a gatekeeper over HTTP with
 * the caller's token. Commands the gatekeeper does not serve fail clearly
 * instead of silently writing to a local file.
 */
import type { Command } from 'commander';
import { openBackend } from './backend.js';

const list = (v?: string): string[] => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

async function emit(fn: () => Promise<unknown>): Promise<void> {
  try {
    console.log(JSON.stringify(await fn(), null, 2));
  } catch (e) {
    console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  }
}

/** Commands available against a server; everything else is local-only. */
export const REMOTE_COMMANDS = ['write', 'review', 'accept', 'search', 'briefing', 'checkpoint'] as const;

export function registerRemoteCommands(root: Command, server: string): void {
  const backend = (provider?: string) => openBackend({ server, provider: provider ?? 'local' });

  root.command('write').description('propose a team memory (a reviewer accepts it)')
    .requiredOption('--workspace <id>').requiredOption('--text <text>').requiredOption('--source <reference>')
    .option('--kind <id>', 'memory kind').option('--allowed-groups <list>', 'groups that may read it')
    .action((o) => emit(async () => (await backend()).propose(o.workspace, o.text, o.source,
      { ...(o.kind ? { kind: o.kind } : {}), ...(o.allowedGroups ? { groups: list(o.allowedGroups) } : {}) })));

  root.command('review').description('proposals waiting for a reviewer')
    .requiredOption('--workspace <id>')
    .action((o) => emit(async () => (await backend()).review(o.workspace)));

  root.command('accept').description('accept a proposal (you, a human reviewer; not your own)')
    .argument('<id>').requiredOption('--workspace <id>').requiredOption('--revision <n>')
    .action((id, o) => emit(async () => (await backend()).accept(o.workspace, id, Number(o.revision))));

  root.command('search').description('accepted memories you may read')
    .argument('<query>').requiredOption('--workspace <id>')
    .option('--provider <name>', 'read as this agent (eligibility filter)').option('--kinds <list>')
    .action((query, o) => emit(async () => (await backend(o.provider)).search(o.workspace, query, { kinds: list(o.kinds) })));

  root.command('briefing').description('resume packet: your checkpoint and its accepted decisions')
    .requiredOption('--workspace <id>').option('--provider <name>', 'read as this agent', 'cursor')
    .action((o) => emit(async () => (await backend(o.provider)).briefing(o.workspace)));

  const checkpoint = root.command('checkpoint').description('provisional task state (not an approved memory)');
  checkpoint.command('show').requiredOption('--workspace <id>')
    .action((o) => emit(async () => ({ checkpoint: await (await backend()).getCheckpoint(o.workspace) })));
  checkpoint.command('set').requiredOption('--workspace <id>').requiredOption('--goal <text>')
    .requiredOption('--state <text>').requiredOption('--next-action <text>').requiredOption('--source <reference>')
    .option('--blockers <items>', 'comma-separated', '').option('--decisions <ids>', 'accepted memory ids', '')
    .option('--revision <n>', 'required after the first write; use 0 to create', '')
    .option('--groups <list>', 'groups that may read this checkpoint')
    .action((o) => emit(async () => (await backend()).setCheckpoint({
      workspace: o.workspace, goal: o.goal, state: o.state, nextAction: o.nextAction, source: o.source,
      blockers: list(o.blockers), decisionRefs: list(o.decisions),
      revision: o.revision === '' || o.revision === undefined ? null : Number(o.revision),
      ...(o.groups !== undefined ? { allowedGroups: list(o.groups) } : {}),
    })));
}
