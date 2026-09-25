import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { openMemoryStore, type OpenMemoryStore } from './openMemoryStore.js';
import { runMemoryPilot } from './pilot.js';
import { DEFAULT_RESUME_WORKSPACE } from '@shared_ptr/contract';
import { BOOTSTRAP_CHECKPOINT } from './bootstrap.js';
import { agentctlCliPilotRunner } from './pilotRunner.js';
import { loadAuthContext, type Classification } from './authContext.js';
import { parseKindList } from './kinds.js';
import { runMemoryRemote } from './remote.js';

function applyAuthCliOptions(o: { asUser?: string; groups?: string; clearance?: string }): void {
  if (o.asUser) setEnv('USER_ID', o.asUser);
  if (o.groups !== undefined) setEnv('GROUPS', o.groups);
  if (o.clearance) setEnv('CLEARANCE', o.clearance);
}

function authOptions(cmd: Command): void {
  cmd
    .option('--as-user <id>', 'Auth context: user id (or AGENTCTL_USER_ID)')
    .option('--groups <list>', 'Comma-separated group ids (or AGENTCTL_GROUPS)')
    .option('--clearance <level>', 'public | internal | confidential', 'internal');
}

function memoryAccessOptions(cmd: Command): void {
  cmd
    .option('--kind <id>', 'memory kind from config/memory-kinds.yaml', 'decision')
    .option('--owner <userId>', 'owner_user_id for attribution or private memory')
    .option('--allowed-groups <list>', 'Comma-separated groups that may read team memory', '')
    .option('--classification <level>', 'public | internal | confidential', 'internal')
    .option('--visibility <scope>', 'team | private', 'team');
}

import type { EvidenceGateInput } from './turnGraph.js';
import { setting, setEnv } from './env.js';

function parseEvidenceGate(o: {
  layaEvidence?: boolean;
  jevEvidence?: boolean;
}): EvidenceGateInput | undefined {
  if (o.layaEvidence === undefined && o.jevEvidence === undefined) return undefined;
  return { laya: o.layaEvidence, jev: o.jevEvidence };
}

function parseSaveAccess(o: {
  kind: string; owner?: string; allowedGroups?: string; classification?: string; visibility?: string;
}) {
  return {
    kind: o.kind,
    ownerUserId: o.owner ?? null,
    allowedGroups: o.allowedGroups ? o.allowedGroups.split(',').map((v: string) => v.trim()).filter(Boolean) : [],
    classification: (o.classification ?? 'internal') as Classification,
    visibility: (o.visibility === 'private' ? 'private' : 'team') as 'team' | 'private',
  };
}

/** Register the server-side commands on `memory` (the shared_ptr root command). */
export function registerMemoryCommands(memory: Command): void {
  memory.command('test').description('three live Cursor/Composer calls against isolated synthetic memory; no manual IDs')
    .action(async () => {
      try {
        const result = await runMemoryPilot(agentctlCliPilotRunner({ agent: 'cursor', model: 'composer-2.5', timeoutSeconds: 90 }));
        console.log(JSON.stringify(result,null,2));
        if (!result.ok) process.exitCode=1;
      } catch(e) { console.error(JSON.stringify({error:e instanceof Error?e.message:String(e)}));process.exitCode=1; }
    });
  const run = async (
    fn: (store: OpenMemoryStore) => unknown | Promise<unknown>,
    o?: { asUser?: string; groups?: string; clearance?: string },
  ) => {
    if (o) applyAuthCliOptions(o);
    let store: OpenMemoryStore | undefined;
    try {
      store = await openMemoryStore(undefined, { auth: loadAuthContext() });
      console.log(JSON.stringify(await fn(store), null, 2));
    } catch (e) {
      console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      process.exitCode = 1;
    } finally {
      await Promise.resolve(store?.close());
    }
  };
  memory.command('kinds').description('list registered memory kinds from AGENTCTL_HOME/config/memory-kinds.yaml')
    .action(async () => run(async () => {
      const { loadKindRegistry } = await import('./kinds.js');
      return loadKindRegistry();
    }));
  const remote = memory.command('remote')
    .description('Admin-only: run `agentctl memory …` on the VM via SSH (not for delegate/ask; use AGENTCTL_GATEWAY_URL + memory serve for team Q&A)')
    .option('--host <target>', 'SSH target user@host', setting('SSH_HOST'))
    .option('--remote-home <path>', 'Remote AGENTCTL_HOME', setting('REMOTE_HOME'))
    .argument('[memoryArgs...]', 'subcommand and flags, e.g. briefing --workspace team-sec-cve');
  authOptions(remote);
  remote.action((memoryArgs, o) => {
    applyAuthCliOptions(o);
    const host = o.host ?? setting('SSH_HOST');
    if (!host) {
      console.error(JSON.stringify({ error: 'Provide --host or AGENTCTL_SSH_HOST' }));
      process.exitCode = 1;
      return;
    }
    if (!memoryArgs.length) {
      console.error(JSON.stringify({ error: 'Provide memory subcommand after remote, e.g. remote briefing --workspace …' }));
      process.exitCode = 1;
      return;
    }
    const forward = [...memoryArgs];
    if (o.asUser) forward.push('--as-user', o.asUser);
    if (o.groups !== undefined) forward.push('--groups', o.groups);
    if (o.clearance) forward.push('--clearance', o.clearance);
    const result = runMemoryRemote(host, o.remoteHome, forward);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  });
  const save = memory.command('save').requiredOption('--workspace <id>').requiredOption('--text <text>')
    .requiredOption('--source <reference>').option('--providers <names>', 'comma-separated permitted destinations; default local-only','')
    .option('--key <key>', 'stable replay/idempotency key').option('--accept', 'explicitly approve this supplied claim',false);
  authOptions(save);
  memoryAccessOptions(save);
  save.action(async o => run(s => s.save({
    workspace:o.workspace,text:o.text,source:o.source,
    providers:o.providers ? o.providers.split(',').map((v:string)=>v.trim()) : [],
    state:o.accept ? 'accepted':'proposed',key:o.key ?? randomUUID(),
    ...parseSaveAccess(o),
  }), o));
  const review = memory.command('review').requiredOption('--workspace <id>');
  authOptions(review);
  review.action(async o => run(s=>s.review(o.workspace), o));
  for (const action of ['inspect','history'] as const) {
    const cmd = memory.command(action).argument('<id>').requiredOption('--workspace <id>');
    authOptions(cmd);
    cmd.action(async (id,o)=>run(s=>s[action](o.workspace,id), o));
  }
  for (const action of ['accept','correct','forget'] as const) {
    const cmd = memory.command(action).argument('<id>').requiredOption('--workspace <id>').requiredOption('--revision <n>');
    authOptions(cmd);
    if (action === 'correct') cmd.requiredOption('--text <text>').requiredOption('--source <reference>');
    cmd.action(async (id,o)=>run(s=>s.change(o.workspace,id,Number(o.revision),action,o.text,o.source), o));
  }
  const search = memory.command('search').argument('<query>').requiredOption('--workspace <id>').option('--provider <name>','destination or local','local')
    .option('--kinds <list>', 'Comma-separated kind ids (default: all kinds)')
    .option('--laya-evidence', 'run local Laya System-1 gate on FTS shortlist (or AGENTCTL_LAYA_EVIDENCE=1)')
    .option('--jev-evidence', 'run hosted TypeSafe Jev gate (or AGENTCTL_JEV_EVIDENCE=1; needs TYPESAFE_API_KEY)');
  authOptions(search);
  search.action(async (query,o)=>run(async s=>await s.search(
    o.workspace,query,o.provider,10,parseKindList(o.kinds),
    parseEvidenceGate({ layaEvidence: o.layaEvidence, jevEvidence: o.jevEvidence }),
  ), o));
  const handoff = memory.command('handoff').argument('<query>').requiredOption('--workspace <id>').requiredOption('--provider <name>')
    .requiredOption('--goal <text>').option('--max-bytes <n>','UTF-8 byte ceiling, not a token count','3000')
    .option('--kinds <list>', 'Comma-separated kind ids')
    .option('--laya-evidence', 'run local Laya System-1 gate on FTS shortlist (or AGENTCTL_LAYA_EVIDENCE=1)')
    .option('--jev-evidence', 'run hosted TypeSafe Jev gate (needs TYPESAFE_API_KEY)');
  authOptions(handoff);
  handoff.option('--graph-trace', 'include graph node trace in handoff JSON');
  handoff.action(async (query,o)=>run(async s=>await s.handoff(
    o.workspace,query,o.provider,o.goal,Number(o.maxBytes),parseKindList(o.kinds),
    parseEvidenceGate({ layaEvidence: o.layaEvidence, jevEvidence: o.jevEvidence }),
    Boolean(o.graphTrace),
  ), o));
  const graph = memory.command('graph').description('declarative turn/control graphs (backend flow)');
  graph.command('show').description('print loaded turn-graph document')
    .action(async () => run(async () => {
      const { loadTurnGraphDocument } = await import('./turnGraph.js');
      const { loadMemoryWritePipeline } = await import('./memoryWriteGraph.js');
      return {
        document: loadTurnGraphDocument(),
        pipelines: {
          memory_write: loadMemoryWritePipeline(),
        },
      };
    }));
  graph.command('trace').argument('<query>').requiredOption('--workspace <id>')
    .option('--provider <name>', 'destination or local', 'local')
    .option('--kinds <list>', 'Comma-separated kind ids')
    .option('--laya-evidence', 'enable Laya gate')
    .option('--jev-evidence', 'enable hosted Jev gate')
    .action(async (query, o) => run(async s => await s.searchWithGraph(
      o.workspace, query, o.provider, 10, parseKindList(o.kinds),
      parseEvidenceGate({ layaEvidence: o.layaEvidence, jevEvidence: o.jevEvidence }),
    ), o));
  const write = memory.command('write')
    .description('propose or commit team memory via memory_write graph (not inline in /v1/turn)')
    .requiredOption('--workspace <id>')
    .requiredOption('--text <text>')
    .requiredOption('--source <reference>')
    .option('--mode <mode>', 'propose | commit', 'propose')
    .option('--key <key>', 'idempotency key')
    .option('--providers <names>', 'comma-separated', '')
    .option('--human-approved', 'required for commit mode', false);
  authOptions(write);
  memoryAccessOptions(write);
  write.action(async o => run(async s => await s.writeWithGraph({
    mode: o.mode === 'commit' ? 'commit' : 'propose',
    workspace: o.workspace,
    text: o.text,
    source: o.source,
    key: o.key,
    providers: o.providers ? o.providers.split(',').map((v: string) => v.trim()).filter(Boolean) : [],
    kind: o.kind,
    owner_user_id: o.owner ?? null,
    allowed_groups: o.allowedGroups ? o.allowedGroups.split(',').map((v: string) => v.trim()).filter(Boolean) : [],
    classification: o.classification,
    visibility: o.visibility,
    human_approved: Boolean(o.humanApproved),
  }), o));
  memory.command('laya').description('local Laya evidence gate (optional; parallel to hosted Jev)')
    .command('ping')
    .description('verify Python laya package and bundled script')
    .action(async () => run(async () => {
      const { selectEvidence, loadLayaConfig } = await import('./layaEvidence.js');
      const cfg = loadLayaConfig();
      const r = await selectEvidence('ping test query', [
        { id: 'a', text: 'The ping test answer is alpha.' },
        { id: 'b', text: 'Unrelated chatter about lunch.' },
      ], { ...cfg, enabled: true });
      return { config: cfg, ping: r };
    }));
  memory.command('jev').description('optional hosted TypeSafe Jev evidence gate (parallel to local Laya)')
    .command('ping')
    .description('check TYPESAFE_API_KEY and optional model override')
    .action(async () => run(async () => {
      const { jevEvidenceEnabled } = await import('./jevEvidence.js');
      const key = Boolean(process.env.TYPESAFE_API_KEY?.trim());
      return {
        typesafe_api_key: key ? 'present' : 'missing',
        jev_evidence_enabled: jevEvidenceEnabled(true, 'jev'),
        model: setting('JEV_MODEL')?.trim() || 'jev-latest',
      };
    }));
  const checkpoint = memory.command('checkpoint')
    .description('explicit scoped task checkpoint (provisional state, not an approved memory)');
  checkpoint.command('show').requiredOption('--workspace <id>')
    .action(async o => run(s => ({ checkpoint: s.getCheckpoint(o.workspace) })));
  checkpoint.command('bootstrap').description('create default resume checkpoint when none exists')
    .option('--workspace <id>', 'workspace id', DEFAULT_RESUME_WORKSPACE)
    .action(async o => run(async s => {
      const workspace = o.workspace ?? DEFAULT_RESUME_WORKSPACE;
      const existing = s.getCheckpoint(workspace);
      if (existing) return { bootstrapped: false, checkpoint: existing, reason: 'already exists' };
      return {
        bootstrapped: true,
        checkpoint: s.setCheckpoint({
          workspace, revision: 0, goal: BOOTSTRAP_CHECKPOINT.goal, state: BOOTSTRAP_CHECKPOINT.state,
          blockers: [...BOOTSTRAP_CHECKPOINT.blockers], nextAction: BOOTSTRAP_CHECKPOINT.nextAction,
          decisionRefs: [], source: BOOTSTRAP_CHECKPOINT.source,
        }),
      };
    }));
  checkpoint.command('set').requiredOption('--workspace <id>').requiredOption('--goal <text>')
    .requiredOption('--state <text>').requiredOption('--next-action <text>')
    .requiredOption('--source <reference>').option('--blockers <items>', 'comma-separated', '')
    .option('--decisions <ids>', 'comma-separated approved memory ids', '')
    .option('--revision <n>', 'required after the first write; use 0 to create', '')
    .option('--groups <list>', 'comma-separated groups that may read this checkpoint via memory serve (owner is AGENTCTL_USER_ID)')
    .action(async o => run(s => s.setCheckpoint({
      workspace: o.workspace, goal: o.goal, state: o.state, nextAction: o.nextAction,
      source: o.source,
      blockers: o.blockers ? o.blockers.split(',').map((v: string) => v.trim()).filter(Boolean) : [],
      decisionRefs: o.decisions ? o.decisions.split(',').map((v: string) => v.trim()).filter(Boolean) : [],
      revision: o.revision === '' || o.revision === undefined ? null : Number(o.revision),
      allowedGroups: o.groups === undefined
        ? undefined
        : o.groups.split(',').map((v: string) => v.trim()).filter(Boolean),
    })));
  const briefing = memory.command('briefing').requiredOption('--workspace <id>').option('--provider <name>', 'destination or local', 'local')
    .option('--max-bytes <n>', 'UTF-8 byte ceiling for the full briefing packet', '8000')
    .option('--kinds <list>', 'Comma-separated kind ids (default: kinds with briefing_default in registry)');
  authOptions(briefing);
  briefing.action(async o => run(
    s => s.resumeBriefing(o.workspace, o.provider, Number(o.maxBytes), parseKindList(o.kinds)),
    o,
  ));
  const postgres = memory.command('postgres').description('PostgreSQL memory plane (scaffold: migrations + status; store adapter not wired in 0.2.x)');
  postgres.command('status')
    .description('Show backend env, migration files, and whether the pg driver is installed')
    .action(async () => {
      const { postgresStatusPayload } = await import('./postgres/migrate.js');
      console.log(JSON.stringify(await postgresStatusPayload(), null, 2));
    });
  postgres.command('migrate')
    .description('Apply SQL migrations from the shared_ptr package (postgres/migrations) (requires pg on VM)')
    .option('--dry-run', 'List pending migration ids without connecting', false)
    .action(async o => {
      const { runPostgresMigrations } = await import('./postgres/migrate.js');
      try {
        const result = await runPostgresMigrations({ dryRun: Boolean(o.dryRun) });
        console.log(JSON.stringify(result, null, 2));
        if (result.error) process.exitCode = 2;
      } catch (e) {
        console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        process.exitCode = 1;
      }
    });

  memory.command('kb')
    .description('tiered Markdown knowledge-base scaffold under $AGENTCTL_HOME/kb')
    .command('init')
    .description('create playbook/technique/engagement tree + evidence vault dir (pointers only; no secrets)')
    .action(async () => {
      try {
        const { initTeamKb } = await import('./teamKb.js');
        console.log(JSON.stringify(initTeamKb(), null, 2));
      } catch (e) {
        console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        process.exitCode = 1;
      }
    });

  const evidence = memory.command('evidence')
    .description('evidence pointers (vault paths / hashes / ticket URLs — never raw artifacts or secrets)');
  const evidenceAdd = evidence.command('add')
    .requiredOption('--workspace <id>')
    .requiredOption('--label <text>')
    .requiredOption('--uri <pointer>', 'vault path, file URI, or https URL')
    .requiredOption('--source <reference>')
    .option('--sha256 <hex>', 'optional content hash')
    .option('--content-type <type>', 'optional MIME / kind label')
    .option('--key <key>', 'idempotency key');
  authOptions(evidenceAdd);
  memoryAccessOptions(evidenceAdd);
  evidenceAdd.action(async o => run(async s => s.registerEvidence({
    workspace: o.workspace,
    label: o.label,
    uri: o.uri,
    source: o.source,
    sha256: o.sha256,
    contentType: o.contentType,
    key: o.key,
    ...parseSaveAccess(o),
  }), o));
  const evidenceShow = evidence.command('show').argument('<id>').requiredOption('--workspace <id>');
  authOptions(evidenceShow);
  evidenceShow.action(async (id, o) => run(async s => ({ evidence: await Promise.resolve(s.getEvidence(o.workspace, id)) }), o));
  const evidenceList = evidence.command('list').requiredOption('--workspace <id>');
  authOptions(evidenceList);
  evidenceList.action(async o => run(async s => ({ evidence: await Promise.resolve(s.listEvidence(o.workspace)) }), o));

  const finding = memory.command('finding')
    .description('structured findings tracker (ownership, severity, remediation, evidence links)');
  const findingCreate = finding.command('create')
    .requiredOption('--workspace <id>')
    .requiredOption('--title <text>')
    .requiredOption('--source <reference>')
    .option('--finding-key <id>', 'human id e.g. RT-2026-014 (auto if omitted)')
    .option('--engagement <text>')
    .option('--severity <level>', 'critical|high|medium|low|info', 'medium')
    .option('--business-impact <text>')
    .option('--affected-scope <text>')
    .option('--attack-path <text>', 'short non-sensitive narrative')
    .option('--evidence <ids>', 'comma-separated evidence pointer UUIDs', '')
    .option('--attck <ids>', 'comma-separated ATT&CK technique ids', '')
    .option('--detection <result>', 'detected|partially_detected|not_detected|not_tested', 'not_tested')
    .option('--remediation-owner <name>', 'remediation owner display name')
    .option('--remediation <text>')
    .option('--due <YYYY-MM-DD>')
    .option('--retest <result>', 'open|fixed_pending_validation|validated|risk_accepted', 'open')
    .option('--retention <YYYY-MM-DD>')
    .option('--status <status>', 'draft|open|in_remediation|closed', 'draft')
    .option('--key <key>', 'idempotency key');
  authOptions(findingCreate);
  memoryAccessOptions(findingCreate);
  findingCreate.action(async o => run(async s => s.saveFinding({
    workspace: o.workspace,
    title: o.title,
    source: o.source,
    findingKey: o.findingKey,
    engagement: o.engagement,
    severity: o.severity,
    businessImpact: o.businessImpact,
    affectedScope: o.affectedScope,
    attackPathSummary: o.attackPath,
    evidenceRefs: o.evidence ? o.evidence.split(',').map((v: string) => v.trim()).filter(Boolean) : [],
    attckMapping: o.attck ? o.attck.split(',').map((v: string) => v.trim()).filter(Boolean) : [],
    detectionResult: o.detection,
    owner: o.remediationOwner,
    remediation: o.remediation,
    dueDate: o.due,
    retestResult: o.retest,
    retentionDate: o.retention,
    status: o.status,
    key: o.key,
    ...parseSaveAccess(o),
  }), o));
  const findingShow = finding.command('show').argument('<id-or-key>').requiredOption('--workspace <id>');
  authOptions(findingShow);
  findingShow.action(async (id, o) => run(async s => ({ finding: await Promise.resolve(s.getFinding(o.workspace, id)) }), o));
  const findingList = finding.command('list').requiredOption('--workspace <id>')
    .option('--status <status>')
    .option('--severity <level>');
  authOptions(findingList);
  findingList.action(async o => run(async s => ({
    findings: await Promise.resolve(s.listFindings(o.workspace, { status: o.status, severity: o.severity })),
  }), o));
  const findingUpdate = finding.command('update')
    .argument('<id>')
    .requiredOption('--workspace <id>')
    .requiredOption('--revision <n>')
    .requiredOption('--source <reference>')
    .option('--title <text>')
    .option('--engagement <text>')
    .option('--severity <level>')
    .option('--business-impact <text>')
    .option('--affected-scope <text>')
    .option('--attack-path <text>')
    .option('--evidence <ids>', 'replace evidence pointer list')
    .option('--attck <ids>')
    .option('--detection <result>')
    .option('--remediation-owner <name>')
    .option('--remediation <text>')
    .option('--due <YYYY-MM-DD>')
    .option('--retest <result>')
    .option('--retention <YYYY-MM-DD>')
    .option('--status <status>')
    .option('--allowed-groups <list>', 'replace ACL groups')
    .option('--classification <level>')
    .option('--visibility <scope>')
    .option('--acl-owner <userId>', 'ACL owner_user_id');
  authOptions(findingUpdate);
  findingUpdate.action(async (id, o) => run(async s => s.updateFinding({
    id,
    workspace: o.workspace,
    revision: Number(o.revision),
    source: o.source,
    title: o.title,
    engagement: o.engagement,
    severity: o.severity,
    businessImpact: o.businessImpact,
    affectedScope: o.affectedScope,
    attackPathSummary: o.attackPath,
    evidenceRefs: o.evidence === undefined
      ? undefined
      : o.evidence.split(',').map((v: string) => v.trim()).filter(Boolean),
    attckMapping: o.attck === undefined
      ? undefined
      : o.attck.split(',').map((v: string) => v.trim()).filter(Boolean),
    detectionResult: o.detection,
    owner: o.remediationOwner,
    remediation: o.remediation,
    dueDate: o.due,
    retestResult: o.retest,
    retentionDate: o.retention,
    status: o.status,
    allowedGroups: o.allowedGroups === undefined
      ? undefined
      : o.allowedGroups.split(',').map((v: string) => v.trim()).filter(Boolean),
    classification: o.classification,
    visibility: o.visibility,
    ownerUserId: o.aclOwner === undefined ? undefined : o.aclOwner,
  }), o));
  const findingLink = finding.command('link-evidence')
    .argument('<finding-id>')
    .requiredOption('--workspace <id>')
    .requiredOption('--evidence <uuid>')
    .requiredOption('--revision <n>')
    .requiredOption('--source <reference>');
  authOptions(findingLink);
  findingLink.action(async (id, o) => run(async s => s.linkEvidenceToFinding(
    o.workspace, id, o.evidence, Number(o.revision), o.source,
  ), o));

  const sessiongraph = memory.command('sessiongraph')
    .description('Nightly memory-plane export + external SessionGraph analysis (set AGENTCTL_SESSIONGRAPH_ROOT)');
  sessiongraph.command('export')
    .description('Write sessiongraph.memory_plane.v1 JSON from audit log + store stats')
    .option('--since <window>', '24h, 7d, or ISO start time', '24h')
    .option('--out <path>', 'output JSON path (default: $AGENTCTL_HOME/exports/memory-plane-YYYY-MM-DD.json)')
    .action(async o => {
      try {
        const { buildMemoryPlaneExport, datedExportPath, parseSinceToMs, writeMemoryPlaneExport } = await import(
          './memoryUsageExport.js'
        );
        const sinceMs = parseSinceToMs(o.since ?? '24h');
        const out = o.out ?? datedExportPath();
        const payload = await buildMemoryPlaneExport(sinceMs);
        writeMemoryPlaneExport(payload, out);
        console.log(JSON.stringify({ ok: true, path: out, schema: payload.schema, period: payload.period }, null, 2));
      } catch (e) {
        console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        process.exitCode = 1;
      }
    });
  sessiongraph.command('analyze')
    .description('Run SessionGraph analyze-memory-plane on an export (requires uv + checkout)')
    .requiredOption('--input <path>', 'memory-plane export JSON')
    .option('--out <dir>', 'report directory', '')
    .action(async o => {
      const { datedReportDir } = await import('./memoryUsageExport.js');
      const { analyzeMemoryPlaneExport } = await import('./sessiongraphBridge.js');
      const outDir = o.out || datedReportDir();
      try {
        const result = await analyzeMemoryPlaneExport(o.input, outDir);
        if (result.stdout.trim()) process.stdout.write(result.stdout);
        if (result.stderr.trim()) process.stderr.write(result.stderr);
        console.log(JSON.stringify({ ok: result.exitCode === 0, analysis_dir: outDir, exit_code: result.exitCode }, null, 2));
        if (result.exitCode !== 0) process.exitCode = result.exitCode;
      } catch (e) {
        console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        process.exitCode = 1;
      }
    });
  sessiongraph.command('nightly')
    .description('export → analyze-memory-plane → suggest-workflow (agentctl target); for systemd timer')
    .option('--since <window>', 'audit window', '24h')
    .option('--export-out <path>', 'override export JSON path')
    .option('--report-dir <dir>', 'override analysis output directory')
    .option('--dry-run', 'validate env/paths only', false)
    .option('--skip-suggest', 'skip suggest-workflow step', false)
    .action(async o => {
      const { runMemorySessiongraphNightly } = await import('./sessiongraphNightly.js');
      try {
        const result = await runMemorySessiongraphNightly({
          since: o.since,
          exportPath: o.exportOut,
          reportDir: o.reportDir,
          dryRun: Boolean(o.dryRun),
          skipSuggest: Boolean(o.skipSuggest),
        });
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
      } catch (e) {
        console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        process.exitCode = 1;
      }
    });
  const serve = memory.command('serve')
    .description('HTTP Memory Gatekeeper (POST /v1/context, POST /v1/turn) — long-lived; Ctrl+C to stop');
  const tokenCommand = async (fn: () => unknown) => {
    try {
      if (Number(process.env.AGENTCTL_WORKER_DEPTH ?? 0) > 0) {
        throw new Error('Serve tokens require the operator; workers cannot issue or revoke them.');
      }
      console.log(JSON.stringify(await fn(), null, 2));
    } catch (e) {
      console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      process.exitCode = 1;
    }
  };
  const token = serve.command('token')
    .description('per-user bearer tokens for memory serve ($AGENTCTL_HOME/serve-tokens.json, sha256 only)');
  token.command('add')
    .description('issue a token for one user; the secret is printed once')
    .requiredOption('--user <id>', 'user id the token authenticates as')
    .option('--groups <list>', 'comma-separated groups', '')
    .option('--clearance <level>', 'public | internal | confidential', 'internal')
    .action(async o => tokenCommand(async () => {
      const { addServeToken } = await import('./serveTokens.js');
      const clearance = z.enum(['public', 'internal', 'confidential']).parse(o.clearance);
      const { token: secret, entry } = addServeToken({
        userId: o.user,
        groups: o.groups ? o.groups.split(',') : [],
        clearance,
      });
      return {
        ...entry,
        token: secret,
        note: 'Shown once. The client sets AGENTCTL_GATEWAY_TOKEN to this value.',
      };
    }));
  token.command('list')
    .description('list issued tokens (no secrets)')
    .action(async () => tokenCommand(async () => {
      const { listServeTokens } = await import('./serveTokens.js');
      return { tokens: listServeTokens() };
    }));
  token.command('revoke')
    .argument('<id>', 'token id from `token list`')
    .action(async id => tokenCommand(async () => {
      const { revokeServeToken } = await import('./serveTokens.js');
      if (!revokeServeToken(id)) throw new Error(`No serve token with id ${id}.`);
      return { revoked: id };
    }));
  serve
    .option('--host <addr>', 'bind address', setting('SERVE_HOST') ?? '127.0.0.1')
    .option('--port <n>', 'port', setting('SERVE_PORT') ?? '8741')
    .action(async o => {
      const { startMemoryServer } = await import('./serve.js');
      const host = o.host ?? '127.0.0.1';
      const port = Number(o.port ?? 8741);
      await startMemoryServer({ host, port });
      process.stderr.write(`agentctl memory serve listening on http://${host}:${port}\n`);
      process.stderr.write('  GET  /health\n  GET  /v1/memory/review\n  POST /v1/context\n  POST /v1/turn\n  POST /v1/memory/write\n  POST /v1/memory/accept\n');
      await new Promise<void>(() => {});
    });
}
