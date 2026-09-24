# Graph engineering: improving agentctl from prompt + behavior graphs

This is the process agents follow to improve agentctl from evidence. It is written for agents: every step names the command, the file, the field to read, and the rule for acting.

SessionGraph sees each agentctl job and MCP client session as a **graph of nodes and typed edges**. Each graph has two halves:

- **Prompt side:** what the caller asked for. This is the request, and for `agentctl_run_tasks` the requested task DAG.
- **Behavior side:** what agentctl did with it: routing, worker calls, results, re-routes, cascades and refusals.

`agentctl graph analyze` **joins** the two halves. It measures how often each caller's task graphs fail, and which request mistakes make failure more likely. `agentctl graph improve` turns that evidence into node and edge changes to agentctl: tool descriptions, gate rules, routing and retry edges. `agentctl graph compare` then keeps each change or rolls it back.

No prompt, task, context or answer text leaves `$AGENTCTL_HOME`. Graphs carry only ids, sizes, counts, flags and lint codes.

## The loop

```text
 observe ──► export ──► analyze ──► propose ──► apply ──► re-observe ──► compare ──► keep | roll back
 (jobs,      (JSONL     (SessionGraph (improve)   (branch,   (same          (gates)
  MCP trace)  graphs)    + join)                   human      workload)
                                                   merges)
```

```bash
agentctl graph analyze --since 7d --out <before>          # export + SessionGraph + prompt↔behavior join
agentctl graph improve <before>                           # proposals.json / proposals.md
agentctl graph apply <before> <proposal-id> --approve     # new branch + worktree; never merges
# review, rebuild, run a comparable workload, then:
agentctl graph analyze --since 1d --out <after>
agentctl graph compare <before> <after> --proposal <proposal-id>
```

| File | What it holds |
| --- | --- |
| `<dir>/export/jobs/<job>.jsonl` | One graph per job: prompt nodes and behavior nodes |
| `<dir>/export/mcp/<session>.jsonl` | One graph per MCP client session: tool-call sequence with request lint codes |
| `<dir>/sessions/<id>/analysis.json` | SessionGraph per graph: `workflow_health`, findings, edge and merge counts |
| `<dir>/analysis.json` | Aggregate: `findingCounts`, `hotspots` (behavior), `promptBehavior` (join) |
| `<dir>/summary.md` | Human and agent summary, including the spec-issue lift table |
| `<dir>/proposals.json` | Proposals: evidence, targets, change, success metric |

## Graph model

### Nodes

| Node `kind` | `name` | Side | Emitted for | Key `arguments` (content-free) |
| --- | --- | --- | --- | --- |
| `message` (role user) | `<caller>:<kind>` | prompt | every job (root) | `size` (xs/s/m/l/xl), `context`, `issues[]`, for graphs `tasks`/`edges`/`depth`/`width` |
| `task_spec` | `task:<id>` | prompt | each task a caller sent to run_tasks | `size`, `acceptance`, `pinned_agent`, `pinned_model`, `deps`, `issues[]` |
| `job_start` | job kind | behavior | runner started | — |
| `tool_call` | `orchestrator:<phase>` | behavior | lead/planner/verifier call | — |
| `tool_call` | `worker:<agent>` | behavior | worker dispatch or routed delegate | `model`, `effort`, `task` |
| `tool_result` | same as its call | behavior | call outcome | `failureClass`, `model`; `is_error`; `usage` (cost, tokens) |
| `step` | `step:<agent>` | behavior | task/step settled | `attempts`; `is_error` |
| `message` (role user) | `cancel` | behavior | cancel requested | — |
| `finish` | succeeded / failed / cancelled | behavior | terminal record | `is_error` unless succeeded |

MCP session graphs are `tool_call`/`tool_result` pairs, one per agentctl tool call. `arguments` holds `job_id`, `to`, and `issues` (lint codes of the request). Polls of one job share a signature, so over-polling shows up as a SessionGraph loop.

### Edges

Each node has `parent_id`. Nodes with several parents also carry `parent_ids` (first entry equals `parent_id`) and `parent_relations`, which gives the type of each edge:

| Relation | From → to | Meaning |
| --- | --- | --- |
| `requests` | request → `task_spec` | The caller asked for this task |
| `depends_on` | `task_spec` → `task_spec` | Requested dependency (the caller's DAG) |
| `specifies` | `task_spec` → worker `tool_call` | This dispatch executes that requested task |
| `reads` | dependency's `tool_result` → worker `tool_call` | The worker received that result (executed DAG) |
| `decides` | lead `tool_result` → worker `tool_call` | The lead's decision created this task (orchestrate loop) |
| `precedes` | previous event → next | Plain order (the default when no relation is given) |

A requested edge (`depends_on`) paired with an executed edge (`reads`) is how you compare the **requested DAG** with the **executed DAG** node by node. Three cases:
- A `task_spec` with no `specifies` child was never run: it was skipped, blocked, or the graph was refused.
- A task with two `worker:` calls was re-routed.
- A skipped task whose dependency failed is a **cascade**: failure propagated along an edge.

### Invariants (tests enforce them)

1. Exports are content-free. Tests assert that instruction, context and worker-output text never appear.
2. `parent_ids[0] === parent_id`, ids are unique, and relations only name declared parents (SessionGraph's parser rejects anything else).
3. Every `worker:` `tool_result` points at its call, so SessionGraph's repeat, loop and dead-end detectors work.
4. A refused graph has no dispatch and no step events. A graph blocked by the approval gate has step events, so it is *not* counted as refused.

## Prompt ↔ behavior join (`analysis.json → promptBehavior`)

| Field | Definition | Use it to |
| --- | --- | --- |
| `taskGraphs.overall` / `taskGraphs.byCaller.<caller>` | Per caller (`claude`, `pi`, `codex`, `cursor`, `cli`): `graphs`, `succeeded`, `failed` (≥1 task failed), `rejected` (refused before running), `cancelled`, `unfinished` | See who struggles |
| `…failRate` | `(rejected + failed) / (succeeded + rejected + failed)`; cancellations excluded | **The headline metric:** how often callers' task graphs fail |
| `…taskFailures`, `cascadeSkips`, `rerouted` | Behavior along nodes and edges | Tell spec problems from lane problems |
| `…rejections.<code>` | Refusal reasons, classified | Direct evidence that callers misread the tool |
| `units` | Smallest things that pass or fail on their own spec: executed tasks, refused graphs, single-prompt jobs. Skipped, blocked and cancelled tasks are excluded, because they are not their own spec's fault | Base rate |
| `issues.<code>` | `units`, `failed`, `failRate` of units that carry the code, and `lift = failRate(with) / failRate(without)`. `lift: null` means units without the code never failed | Which request mistake predicts failure |

Attribution rules:
- A refused graph is blamed only on its refusal code.
- An executed task carries its own task codes plus its graph's codes.
- Lift is correlation, not proof. That is why every change must pass `compare` on a fresh workload.

## Spec rules (prompt-side lint)

`src/graph/specRules.ts` is the single registry. Each code has a detector and one guidance sentence, and three places quote that sentence verbatim: `spec_warnings` in run_tasks results (MCP, CLI `jobs start tasks`, Pi), the run_tasks tool description once the code is activated, and proposals.

| Code | Scope | Detected when |
| --- | --- | --- |
| `no_acceptance` | task | no `acceptance` |
| `thin_instruction` | task | instruction < 60 characters |
| `oversized_instruction` | task | instruction > 6000 characters |
| `refers_outside` | task | "as discussed", "the previous file", "this conversation"… and no `context` |
| `strong_model_pinned` | task | `model` set (analysis only; not warned) |
| `wide_fan_in` | task | ≥ 4 dependencies |
| `single_task` | graph | one task (use agentctl_delegate) |
| `serial_chain` | graph | ≥ 3 tasks and depth = task count (no parallelism) |
| `no_shared_context` | graph | ≥ 2 tasks and no `context` |
| `duplicate_id`, `unknown_dependency`, `duplicate_dependency`, `cycle` | graph | structural; the runner refuses these |
| `not_on_roster`, `lane_unavailable`, `missing_capability`, `bad_model`, `bad_effort`, `invalid_graph` | rejection | classified from the runner's refusal message |
| `prompt_thin`, `prompt_refers_outside` | prompt | delegate/orchestrate/ask text < 25 characters, or refers outside with no `context` |

Adding a rule means four edits: the detector in `lintTaskGraph`/`lintPrompt` (or the pattern in `classifyRejection`), an entry in `SPEC_RULES`, a row in this table (a test checks that every code is documented), and a test.

## Optimization moves (node and edge operations)

Each move names the evidence that justifies it and the metric that must move afterwards.

| Evidence (where) | Graph reading | Move | Kind | Metric |
| --- | --- | --- | --- | --- |
| `rejections.<code>` ≥ 2 | Caller DAG never reached execution | **Tighten** the run_tasks description with the code's guidance; if already active, **enforce** at the gate | prompt-source node | `promptBehavior.taskGraphs.overall.rejections.<code>` ↓ |
| `issues.<code>` lift ≥ 1.5 (≥ 3 units, ≥ 2 failed) | Spec node attribute predicts failure | Tighten, then enforce | prompt-source node | `promptBehavior.issues.<code>.failRate` ↓ |
| `byCaller.<c>.failRate` ≥ 0.2 over ≥ 3 graphs, no issue implicated | Failures sit on behavior nodes | Investigate lanes: route around, re-route before cascading | behavior node or edge | `promptBehavior.taskGraphs.byCaller.<c>.failRate` ↓ |
| `serial_chain` lift | Spurious `depends_on` edges | Tell callers to drop non-data edges (edge removal) | edge | `promptBehavior.issues.serial_chain.failRate` ↓ |
| `wide_fan_in` lift | Merge node overloaded | Insert a condensing node before it (node insertion) | node | `promptBehavior.issues.wide_fan_in.failRate` ↓ |
| `cascadeSkips` high | One failure kills a subtree | Add a re-route or fallback edge before skipping dependents | edge | `promptBehavior.taskGraphs.overall.cascadeSkips` ↓ |
| `hotspots.lanes.<lane>.byFailureClass.usage_limit` | Node on a capped lane | Route around the capped lane | node reassignment | `lanes.<lane>.byFailureClass.usage_limit` ↓ |
| `hotspots.lanes.<lane>.byFailureClass.timeout` | Node too big for its lane | Raise the timeout or split the node | node split | `lanes.<lane>.byFailureClass.timeout` ↓ |
| `hotspots.pollsPerJob.mean` > 3 | Self-loop on `job_wait` | Longer waits per call | loop edge | `pollsPerJob.mean` ↓ |
| SessionGraph `dead_end` | Terminal node is an error | Terminal handoff node with one safe next action | node | `findingCounts.dead_end` ↓ |

### Escalation ladder for request mistakes

1. **Warn** (always on). Every run_tasks result includes `spec_warnings: [{code, tasks?, fix}]`. The call still runs.
2. **Describe.** Add the code to `RUN_TASKS_ACTIVE_HINTS` in `src/graph/specRules.ts`. The MCP run_tasks description then ends with `Rules: <guidance…>`. Append the same sentence to the Pi `agentctl_run_tasks` description in `integrations/pi/agentctl.ts`. `graph improve` proposes this as `tighten-run-tasks-<code>`.
3. **Enforce.** If an active code still crosses the thresholds, `graph improve` proposes `enforce-<code>`. The MCP handler refuses the request (or repairs it, if that loses nothing) before a job starts, with the guidance as the error.

Climb one rung at a time. Never skip to enforcement without a failed `compare` at rung 2. Descriptions are read on every call by every client, so each hint costs tokens and attention everywhere. **An empty `RUN_TASKS_ACTIVE_HINTS` is the correct state until evidence says otherwise.**

Thresholds are in `SPEC_THRESHOLDS` (`src/graph/improve.ts`):

| Threshold | Value |
| --- | --- |
| Finished graphs before a caller's rate counts | ≥ 3 |
| Caller fail rate that calls for tightening | ≥ 0.2 |
| Refusals of one code | ≥ 2 |
| Issue lift evidence | ≥ 3 units, ≥ 2 failed, and lift ≥ 1.5 (or fail rate ≥ 0.3 when the baseline is 0) |

Below these, `improve` stays quiet.

## Agent playbook

**If you are improving agentctl:**

1. Run `agentctl graph analyze --since 7d`. Read `summary.md`, then `analysis.json → promptBehavior` and `hotspots`.
2. If `taskGraphs.overall.graphs` < 3, stop and report "not enough evidence". Do not tighten descriptions on intuition.
3. Run `agentctl graph improve <dir>`. Take the highest-severity proposal. Read `evidence`, `targets`, `change` and `metric`.
4. Implement exactly that change on a branch. The quickest way is `agentctl graph apply <dir> <id> --approve`, which only creates a worktree. Run `npm run check`. The human reviews and merges.
5. After the merged build has seen a comparable workload, run `agentctl graph analyze --out <after>`, then `agentctl graph compare <before> <after> --proposal <id>`.
6. `verdict: keep` → done. Otherwise roll back or try the next rung. Record the outcome in the PR or handoff: before and after metric, and verdict.

`compare` passes only if all of these hold:
- mean `workflow_health` does not drop;
- no SessionGraph finding type grows;
- the caller-graph `failRate` does not rise;
- the proposal's metric moves in its direction.

**If you are calling `agentctl_run_tasks`:**

- Give every task a self-contained `instruction` and an `acceptance` line. Put shared facts once in `context`.
- Use `depends_on` only for real data dependencies. Independent tasks then run in parallel, 3 at a time.
- Pin `agent` only to a name that `agentctl_agents` lists as `available`, or omit it. Pin `model` only for hard tasks.
- Read `spec_warnings` in the result. Each has a `fix`, so apply it to your follow-up call.

## Code map

| Concern | File |
| --- | --- |
| Rule registry, lint, refusal classifier, warnings, active hints | `src/graph/specRules.ts` |
| Prompt ↔ behavior join and aggregation | `src/graph/promptBehavior.ts` |
| Node and edge export (prompt + behavior) | `src/graph/export.ts` |
| SessionGraph run, hotspots, summary | `src/graph/analyze.ts` |
| Proposals, thresholds, metrics, compare gates | `src/graph/improve.ts` |
| CLI (`graph export/analyze/improve/apply/compare`) | `src/graph/command.ts` |
| MCP descriptions, `spec_warnings`, content-free trace | `src/mcp/server.ts`, `src/mcp/trace.ts` |
| Pi tool pass-through | `integrations/pi/agentctl.ts` |
| Tests | `test/graph.test.ts`, `test/graphPromptBehavior.test.ts`, `test/mcpServer.test.ts` |

Related: [AGENT-INTEGRATION.md](AGENT-INTEGRATION.md#improving-agentctl-from-real-usage-sessiongraph), [TURN-GRAPH.md](TURN-GRAPH.md) (memory-plane graphs), [SESSIONGRAPH-NIGHTLY.md](SESSIONGRAPH-NIGHTLY.md).
