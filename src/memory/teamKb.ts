/**
 * Tiered team shared knowledge — structured findings, evidence pointers,
 * and an on-disk Markdown knowledge-base scaffold.
 *
 * Secrets (credentials, API keys, private keys) are never stored here.
 * Put them in a dedicated secrets manager; this plane only keeps
 * attributable claims, findings, and pointers to encrypted evidence.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { agentctlHome } from '../core/agentHome.js';
import type { Classification } from './authContext.js';

const label = z.string().trim().min(1).max(200);
const longText = z.string().trim().min(1).max(20000);
const dateStr = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional();

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export const DETECTION_RESULTS = ['detected', 'partially_detected', 'not_detected', 'not_tested'] as const;
export const RETEST_RESULTS = ['open', 'fixed_pending_validation', 'validated', 'risk_accepted'] as const;
export const FINDING_STATUSES = ['draft', 'open', 'in_remediation', 'closed'] as const;

/** Reject inline secret material — evidence vault and secrets managers own those. */
const SECRET_PATTERNS: RegExp[] = [
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
  /-----BEGIN PGP PRIVATE KEY BLOCK-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S+/i,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
];

export function assertNoInlineSecrets(field: string, value: string): void {
  for (const re of SECRET_PATTERNS) {
    if (re.test(value)) {
      throw new Error(
        `${field} looks like a credential or private key. Store secrets in a secrets manager; `
        + 'team knowledge only keeps pointers (vault paths, hashes, ticket ids).',
      );
    }
  }
}

export const evidencePointerInputSchema = z.object({
  workspace: label,
  label: label,
  /** Pointer only — vault path, file URI, or ticket URL. Never paste raw evidence or secrets. */
  uri: z.string().trim().min(1).max(4000),
  sha256: z.string().trim().regex(/^[a-fA-F0-9]{64}$/).nullable().optional(),
  contentType: z.string().trim().min(1).max(200).nullable().optional(),
  classification: z.enum(['public', 'internal', 'confidential']).default('confidential'),
  ownerUserId: z.string().trim().min(1).max(200).nullable().optional(),
  allowedGroups: z.array(label).max(32).default([]),
  visibility: z.enum(['team', 'private']).default('team'),
  source: z.string().trim().min(1).max(2000),
  key: label.optional(),
});
export type EvidencePointerInput = z.input<typeof evidencePointerInputSchema>;

export interface EvidencePointer {
  id: string;
  workspace: string;
  label: string;
  uri: string;
  sha256: string | null;
  contentType: string | null;
  classification: Classification;
  ownerUserId: string | null;
  allowedGroups: string[];
  visibility: 'team' | 'private';
  source: string;
  createdAt: number;
}

export const findingInputSchema = z.object({
  workspace: label,
  /** Human-facing id (e.g. RT-2026-014). Auto-assigned when omitted. */
  findingKey: z.string().trim().min(1).max(64).optional(),
  title: label,
  engagement: z.string().trim().min(1).max(500).optional(),
  severity: z.enum(SEVERITIES).default('medium'),
  businessImpact: longText.optional(),
  affectedScope: longText.optional(),
  attackPathSummary: longText.optional(),
  evidenceRefs: z.array(z.string().uuid()).max(64).default([]),
  attckMapping: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
  detectionResult: z.enum(DETECTION_RESULTS).default('not_tested'),
  owner: z.string().trim().min(1).max(200).optional(),
  remediation: longText.optional(),
  dueDate: dateStr,
  retestResult: z.enum(RETEST_RESULTS).default('open'),
  retentionDate: dateStr,
  status: z.enum(FINDING_STATUSES).default('draft'),
  classification: z.enum(['public', 'internal', 'confidential']).default('confidential'),
  ownerUserId: z.string().trim().min(1).max(200).nullable().optional(),
  allowedGroups: z.array(label).max(32).default([]),
  visibility: z.enum(['team', 'private']).default('team'),
  source: z.string().trim().min(1).max(2000),
  key: label.optional(),
});
export type FindingInput = z.input<typeof findingInputSchema>;

export interface Finding {
  id: string;
  findingKey: string;
  workspace: string;
  revision: number;
  title: string;
  engagement: string | null;
  severity: (typeof SEVERITIES)[number];
  businessImpact: string | null;
  affectedScope: string | null;
  attackPathSummary: string | null;
  evidenceRefs: string[];
  attckMapping: string[];
  detectionResult: (typeof DETECTION_RESULTS)[number];
  owner: string | null;
  remediation: string | null;
  dueDate: string | null;
  retestResult: (typeof RETEST_RESULTS)[number];
  retentionDate: string | null;
  status: (typeof FINDING_STATUSES)[number];
  classification: Classification;
  ownerUserId: string | null;
  allowedGroups: string[];
  visibility: 'team' | 'private';
  source: string;
  updatedAt: number;
}

export const findingUpdateSchema = findingInputSchema.partial().omit({ workspace: true }).extend({
  workspace: label,
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  source: z.string().trim().min(1).max(2000),
});
export type FindingUpdateInput = z.input<typeof findingUpdateSchema>;

export function validateEvidencePointerInput(raw: EvidencePointerInput): z.output<typeof evidencePointerInputSchema> {
  const input = evidencePointerInputSchema.parse(raw);
  assertNoInlineSecrets('uri', input.uri);
  assertNoInlineSecrets('label', input.label);
  if (/^(data:|javascript:)/i.test(input.uri)) {
    throw new Error('Evidence uri must be a vault path, file path, or https URL — not an inline data URI.');
  }
  return input;
}

export function validateFindingInput(raw: FindingInput): z.output<typeof findingInputSchema> {
  const input = findingInputSchema.parse(raw);
  for (const [name, value] of Object.entries({
    title: input.title,
    engagement: input.engagement,
    businessImpact: input.businessImpact,
    affectedScope: input.affectedScope,
    attackPathSummary: input.attackPathSummary,
    remediation: input.remediation,
    owner: input.owner,
  })) {
    if (value) assertNoInlineSecrets(name, value);
  }
  return input;
}

export function nextFindingKey(existingKeys: string[], year = new Date().getUTCFullYear()): string {
  const prefix = `RT-${year}-`;
  let max = 0;
  for (const key of existingKeys) {
    if (!key.startsWith(prefix)) continue;
    const n = Number(key.slice(prefix.length));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

/** On-disk Markdown knowledge base under $AGENTCTL_HOME/kb (pointers live in the DB). */
export const KB_TREE: Array<{ path: string; body?: string }> = [
  { path: '00-Governance/README.md', body: '# Governance\n\nRules of engagement, data handling, and retention. Keep approvals as controlled PDFs; this folder holds indexes and pointers.\n' },
  { path: '00-Governance/Rules-of-Engagement.md', body: pageTemplate('Rules of Engagement', 'Engagement authorization boundary') },
  { path: '00-Governance/Data-Handling-Standard.md', body: pageTemplate('Data Handling Standard', 'How the team classifies and retains assessment artifacts') },
  { path: '00-Governance/Retention-Schedule.md', body: pageTemplate('Retention Schedule', 'When to archive or destroy engagement artifacts') },
  { path: '01-Playbooks/README.md', body: '# Playbooks\n\nReusable operating procedures. Link evidence; do not paste secrets.\n' },
  { path: '01-Playbooks/Engagement-Lifecycle.md', body: pageTemplate('Engagement Lifecycle', 'From scoping through report delivery') },
  { path: '01-Playbooks/Reporting.md', body: pageTemplate('Reporting', 'How findings become client-ready reports') },
  { path: '02-Technique-Library/README.md', body: '# Technique library\n\nShort, filterable TTP notes. Prefer ATT&CK ids in front matter. Evidence stays in the vault.\n' },
  { path: '02-Technique-Library/Identity.md', body: pageTemplate('Identity techniques', 'Identity-plane tradecraft notes (sanitized)') },
  { path: '02-Technique-Library/Endpoint.md', body: pageTemplate('Endpoint techniques', 'Endpoint tradecraft notes (sanitized)') },
  { path: '02-Technique-Library/Cloud.md', body: pageTemplate('Cloud techniques', 'Cloud tradecraft notes (sanitized)') },
  { path: '02-Technique-Library/Network.md', body: pageTemplate('Network techniques', 'Network tradecraft notes (sanitized)') },
  { path: '02-Technique-Library/Web-Applications.md', body: pageTemplate('Web application techniques', 'Web app tradecraft notes (sanitized)') },
  { path: '03-Client-Engagements/README.md', body: '# Client engagements\n\nPer-engagement workspaces. Store **links** to findings and evidence — not raw vault contents.\n' },
  { path: '03-Client-Engagements/_template/Scope-and-ROE.md', body: pageTemplate('Scope and RoE', 'Engagement-specific scope index') },
  { path: '03-Client-Engagements/_template/Working-Notes.md', body: pageTemplate('Working notes', 'Day-to-day operator notes (sanitized)') },
  { path: '03-Client-Engagements/_template/Findings-Links.md', body: '# Findings links\n\n| Finding key | Title | Status |\n| --- | --- | --- |\n| _(link via `agentctl memory finding list`)_ | | |\n' },
  { path: '03-Client-Engagements/_template/Evidence-Links.md', body: '# Evidence links\n\n| Pointer id | Label | URI |\n| --- | --- | --- |\n| _(link via `agentctl memory evidence list`)_ | | |\n' },
  { path: '04-Lessons-Learned/README.md', body: '# Lessons learned\n\nSanitized reusable observations — no client-sensitive detail.\n' },
  { path: '05-Templates/finding-page.md', body: pageTemplate('Finding write-up template', 'Narrative companion to a structured finding record') },
  { path: '05-Templates/kb-page.md', body: pageTemplate('Knowledge page template', 'Reusable team knowledge') },
  { path: '06-Training/README.md', body: '# Training\n\nInternal enablement notes and labs indexes.\n' },
];

function pageTemplate(title: string, purpose: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `---
title: ${title}
owner: team
status: draft
classification: team-internal
last_reviewed: ${today}
next_review: ${today}
applies_to: []
attck_mapping: []
retention: engagement close + 90 days
---

# Purpose

${purpose}

# When to use

Clear conditions, assumptions, required authorization, and exclusions.

# Prerequisites

Access, approvals, environment requirements, safety constraints.

# Procedure or guidance

High-level approved steps, decision points, and expected outcomes.

# Detection and validation

Expected telemetry, relevant data sources, what success/failure means.

# Evidence

Link to the approved evidence vault or finding record.
Do not paste secrets or raw sensitive artifacts here.

# Cleanup and rollback

Required cleanup, access removal, artifact deletion, and handoff activities.

# Lessons learned

Sanitized observations, common failure modes, and improvement ideas.

# References

Links to internal policies, assessment records, and authoritative sources.
`;
}

export function kbRoot(home = agentctlHome()): string {
  return join(home, 'kb');
}

export function evidenceVaultRoot(home = agentctlHome()): string {
  return join(home, 'evidence', 'vault');
}

export interface KbInitResult {
  kbRoot: string;
  evidenceVaultRoot: string;
  created: string[];
  skipped: string[];
}

/** Scaffold the Markdown knowledge tree and evidence vault directory (0700). */
export function initTeamKb(home = agentctlHome()): KbInitResult {
  const root = kbRoot(home);
  const vault = evidenceVaultRoot(home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(vault, { recursive: true, mode: 0o700 });
  const created: string[] = [];
  const skipped: string[] = [];
  const readme = join(root, 'README.md');
  if (!existsSync(readme)) {
    writeFileSync(readme, `# Team knowledge base

Tiered layout: Markdown for reusable knowledge, structured findings in the
agentctl memory store, encrypted artifacts under \`evidence/vault/\`, and
credentials only in a secrets manager.

Register evidence with \`agentctl memory evidence add\` (stores a **pointer**,
not the file). Track findings with \`agentctl memory finding …\`.
`, { encoding: 'utf8', mode: 0o600 });
    created.push('README.md');
  } else {
    skipped.push('README.md');
  }
  for (const entry of KB_TREE) {
    const full = join(root, entry.path);
    mkdirSync(join(full, '..'), { recursive: true, mode: 0o700 });
    if (existsSync(full)) {
      skipped.push(entry.path);
      continue;
    }
    writeFileSync(full, entry.body ?? '', { encoding: 'utf8', mode: 0o600 });
    created.push(entry.path);
  }
  const vaultKeep = join(vault, '.gitkeep');
  if (!existsSync(vaultKeep)) {
    writeFileSync(vaultKeep, '', { encoding: 'utf8', mode: 0o600 });
    created.push('evidence/vault/.gitkeep');
  }
  return { kbRoot: root, evidenceVaultRoot: vault, created, skipped };
}
