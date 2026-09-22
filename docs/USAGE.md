# Per-model usage accounting

Run `agentctl usage` for totals grouped by agent and model, or:

```sh
agentctl usage --format json
agentctl usage --model composer-2.5 --since 2026-09-22
```

Tracking is automatic for subprocess invocations through agentctl: ask, delegate,
orchestration, API/chat/Pi-extension dispatch and the memory pilot all use that adapter.
The Pi extension benefits when it dispatches through agentctl; unrelated native Pi turns
are not captured. Browser, Docker and direct external API experiments are outside this
ledger. In particular, the standalone Jev benchmark is not an agentctl runtime adapter.
There is no retrospective import of earlier runs or provider-account billing data.

## Stored evidence

`~/.agentctl/usage/calls.jsonl` stores one event per completed subprocess attempt,
including failure/timeout results. `$AGENTCTL_HOME` changes the root;
`AGENTCTL_USAGE_FILE` changes the file. New directories use 0700 and files use 0600.
Each event has an ID, UTC timestamp, adapter, requested model, result status, latency
and provider usage by model. Prompts, answers, workspaces and credentials are excluded.
A companion README explains the artifact. A ledger-write failure emits a warning
without losing the model's answer. A crash before completion can leave a call unrecorded;
this is observability, not a transactional billing or budget-enforcement system.

Each fallback attempt is charged to its own model rather than the final successful
model. Claude `modelUsage` breakdowns take precedence over its aggregate usage so
helper models are not silently attributed to the requested model. If the provider
omits model identity, the requested label is recorded with `requested` attribution;
no requested alias is represented as a verified backend model.

The reader uses the latest valid event for a repeated ID, permitting reconciliation
from retained provider evidence without double counting. Invalid/truncated lines are
counted and warned about. The CLI has no reset/delete command.

## Counters and limitations

Input/output tokens and reported USD cost are tracked separately. `null` means unknown,
not zero. JSON reports expose a missing-attempt count for each metric. Mixed known and
unknown values produce a reported subtotal, marked `*` in text, not an exact total.
Cost is captured only when supplied; subscription invoices are not inferred from tokens.

- Cursor requests `--output-format json`. The installed CLI's live result contained
  `usage.inputTokens`, `outputTokens`, `cacheReadTokens` and `cacheWriteTokens`.
  Snake-case input/output/cached fields are accepted too. No cost or effective model
  was returned by the validation call.
- Claude input totals include its separately reported cache reads and writes. The
  cache counters remain visible for comparison; do not add them to input again.
- Codex aggregates `turn.completed` events; cached input is already within input.
  If any completed turn omits a counter, that counter for the attempt is unknown.
- Antigravity's structured input/output usage is retained where reported. Text-only
  presets (including the current standalone Pi lane) remain unknown, not estimated.

Cursor and other provider input counters retain their native meaning unless the
normalization above is specified. Cache counters should not be blindly added to input.
Actual provider usage includes context beyond the small memory handoff packet.

## Validation

Tests cover the live Cursor response shape, Claude per-model/cache breakdowns, Codex
multi-turn usage, invalid counters, unknown/partial totals, fallback attribution,
timeout usage, persistence, reconciliation, corruption reporting and write failure.
The local live Cursor check returned `USAGE_OK`: 12,475 input, 41 output,
590 cache-read and zero cache-write tokens. Its retained response was replayed through
the corrected parser to reconcile the initial development record, without another
provider call. The model label is requested Composer 2.5; USD cost is unknown.

Cursor documents structured output in its [CLI output reference](https://docs.cursor.com/en/cli/reference/output-format).
The precise usage field names above are verified against the installed 2026.09.18 CLI,
rather than assumed from an older reference schema.
