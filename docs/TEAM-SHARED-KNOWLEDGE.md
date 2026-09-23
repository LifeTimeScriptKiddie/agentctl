# Team shared knowledge — tiered model

agentctl keeps **four formats** separate. Short claims and checkpoints stay in the
existing memory plane; findings and evidence pointers are first-class tables;
Markdown lives on disk; secrets stay outside agentctl.

## Why tiers

Assessment artifacts need attribution, classification, retention, and an owner.
Forcing every page, finding, PCAP, and credential into one `memories` row
creates either unsafe dumps or unusable free-form text. The split matches common
practice (structured findings + linked evidence + wiki knowledge).

## Layout

```text
$AGENTCTL_HOME/
├── kb/                         # Markdown knowledge base (tier 1)
│   ├── 00-Governance/
│   ├── 01-Playbooks/
│   ├── 02-Technique-Library/
│   ├── 03-Client-Engagements/
│   ├── 04-Lessons-Learned/
│   ├── 05-Templates/
│   └── 06-Training/
├── evidence/vault/             # Encrypted/object files (tier 3) — pointers in DB
├── memory/memory.sqlite        # Claims, checkpoints, findings, evidence_pointers
└── config/memory-kinds.yaml
```

Initialize the tree:

```bash
agentctl memory kb init
```

## Tier 1 — Knowledge base (Markdown)

Reusable playbooks, TTPs, lessons, and engagement indexes. Use the page template
in `05-Templates/kb-page.md` (owner, status, classification, review dates,
ATT&CK, retention). Link vault/finding ids in the **Evidence** section — do not
paste secrets or raw artifacts.

Accepted short claims that point at pages use kinds `playbook`, `technique`,
`lesson`, `process`, `report`.

## Tier 2 — Findings tracker

```bash
agentctl memory finding create --workspace team-reports \
  --title '…' --severity high --engagement 'Client A / Q3' \
  --attck T1078 --status open --source operator:you

agentctl memory finding list --workspace team-reports --status open
agentctl memory finding show RT-2026-001 --workspace team-reports
agentctl memory finding update <uuid> --workspace team-reports \
  --revision 1 --status in_remediation --source operator:you
```

| Field | Purpose |
| --- | --- |
| `findingKey` | Human id (`RT-YYYY-NNN`, auto-assigned) |
| `severity` | critical / high / medium / low / info |
| `detectionResult` | detected / partially_detected / not_detected / not_tested |
| `retestResult` | open / fixed_pending_validation / validated / risk_accepted |
| `status` | draft / open / in_remediation / closed |
| `evidenceRefs` | UUIDs of evidence pointers |
| `attckMapping` | Technique ids |
| `dueDate` / `retentionDate` | `YYYY-MM-DD` |
| ACL | same classification / groups / visibility model as memories |

Postgres: migration `005_findings_evidence.sql`. SQLite: schema `user_version=5`.

## Tier 3 — Evidence pointers

```bash
agentctl memory evidence add --workspace team-reports \
  --label 'auth log excerpt' \
  --uri 'vault://engagement-a/auth.log' \
  --sha256 <64-hex> \
  --source operator:you

agentctl memory finding link-evidence <finding-uuid> \
  --workspace team-reports --evidence <pointer-uuid> \
  --revision N --source operator:you
```

agentctl stores **pointers** (uri, optional sha256, label, ACL) — never the
blob. Keep files under `$AGENTCTL_HOME/evidence/vault/` with host encryption
(disk encryption / age / age-encrypted archives). Inline `data:` URIs and
credential-shaped text are rejected.

Memories may also carry `evidenceRefs` (UUID list) for claims that cite vault
items.

## Tier 4 — Secrets

Credentials, API keys, and private keys belong in a **secrets manager** (1Password,
Vault, cloud SM). agentctl refuses obvious inline secrets in finding fields and
evidence URIs. Do not put secrets in Markdown knowledge pages.

## Gatekeeper HTTP

| Method | Path |
| --- | --- |
| GET | `/v1/finding/list?workspace=` |
| GET | `/v1/finding/show?workspace=&id=` |
| POST | `/v1/finding/create` |
| GET | `/v1/evidence/list?workspace=` |
| POST | `/v1/evidence/add` |

Same bearer-token auth as the rest of `memory serve`.
