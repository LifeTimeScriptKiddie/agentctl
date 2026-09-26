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
| `retries` | failed `tool_result` → next attempt's `tool_call` | Same task retried or re-routed to another lane |
| `cascades` | failed dependency's `step` → skipped task's `step` | The task never ran because a dependency failed |
| `settles` | branch-end `step` → `finish` | A branch of the graph that nothing else read ended here |
| `precedes` | previous event → next | Plain order (the default when no relation is given) |

Task dispatches branch from the lead's decision (orchestrate loop) or from `job_start` (caller-led graphs). A task with dependencies hangs off the results it `reads`, not the start. Parallel tasks are therefore parallel branches, never a chain. `finish` joins every branch end.

A requested edge (`depends_on`) paired with an executed edge (`reads`) is how you compare the **requested DAG** with the **executed DAG** node by node. Three cases:
- A `task_spec` whose only `specifies` child is a 0-attempt `step`, or that has no child at all, never ran: it was skipped, blocked, or the graph was refused.
- A `retries` edge means the task was retried or re-routed.
- A `cascades` edge means failure propagated along a dependency edge.

## Pictures

Every `graph analyze` also writes:

| File | Shows | Use it to |
| --- | --- | --- |
| `graph.html` | Overview (callers → outcomes → refusal reasons and implicated spec issues), plus the workflow of the session to look at first: lowest health, else the largest failed graph, else a refused one, else the latest graph | Open it in a browser first |
| `workflows/<id>.mmd` | One Mermaid flowchart per job and MCP session. An "asked (prompt)" lane (request and task specs) sits beside a "did (behavior)" lane (calls, results, steps, finish). Typed edges are labeled; `retries` is dashed | Inspect any session; it renders in GitHub, Obsidian and VS Code |
| `summary.md` | The overview as a Mermaid block, above the lift table, and a harness digestion table | Read in any Markdown viewer |
| `harness.html` | Harness digestion: Flow (harness → model → outcome) and Back (outcome → directive → source → file) with a toggle, plus one session with its harness lane | See how models take in the harness |

Colors:
- blue: a request or task with a clean spec;
- amber: spec issues, listed after ⚠;
- grey: agentctl calls;
- green or red: results and task steps;
- heavy green or red border: final outcome.

The overview lists an issue only when it clears the same evidence bar as `graph improve` (lift ≥ 1.5, or fail rate ≥ 0.3 with no baseline), so it never flags noise. Pictures are content-free like the exports. `graph.html` loads the Mermaid library from cdn.jsdelivr.net and falls back to showing the diagram source when offline. The weekly job's latest page is `~/.agentctl/graph/latest/graph.html`.

## Harness digestion: flow and back

The prompt ↔ behavior join asks "did the caller's request predict failure?". Harness digestion asks the question one level up: **how do the models agentctl talks to take in the harness agentctl gives them?** The harness is every text a model reads from agentctl: the MCP server instructions, tool descriptions and schemas, `spec_warnings` in results, the lead prompt and the worker prompt. `src/graph/harness.ts` holds it as a registry of **sources** and the **directives** each one states. Every directive has a content-free check. `graph analyze` turns each check into a verdict on the behavior node where it was observed: `followed` or `not_followed`.

```text
 FLOW   harness source ──► directive ──► model that read it ──► behavior (✓ / ✗) ──► run succeeded | failed
 BACK   failed run ──► directive not followed ──► harness source ──► file to edit
                   └─► no directive covers it ──► lane problem or harness gap (reason code)
```

```bash
agentctl graph analyze --since 7d      # also writes harness.html and analysis.json → harness
agentctl graph harness [<dir>]          # JSON: readers, directives with verdicts, back traces, blind spots
```

Open `harness.html`. The toggle switches between **Flow** (left to right: harness → model → outcome) and **Back** (right to left: outcome → directive → source → file). Below that are the readers table, the directives table, failed runs traced back, the sources, and one session's workflow with its harness lane.

### Sources

| Source | Audience | Read when | Edit |
| --- | --- | --- | --- |
| `mcp.instructions` | caller | once per client session | `src/mcp/harnessText.ts` → `mcpInstructions` |
| `tool.run_tasks` | caller | with the tool list | `src/mcp/harnessText.ts` → `RUN_TASKS_DESCRIPTION`; `src/mcp/server.ts` → `taskShape` |
| `tool.other` | caller | with the tool list | `src/mcp/server.ts` → the other `registerTool` calls (no directives yet; fingerprinted so edits are visible) |
| `feedback.spec_warnings` | caller | in the result of a request with spec issues | `src/graph/specRules.ts` → `SPEC_RULES` |
| `prompt.lead` | lead model | every lead round | `src/core/orchestrateLoop.ts` → `buildLeadPrompt` |
| `prompt.worker` | worker models | every task-graph dispatch | `src/core/orchestrateLoop.ts` → `buildWorkerPrompt` |

### Directives and how each is checked

| Directive | Source | Strength | Followed when |
| --- | --- | --- | --- |
| `wait_until_done` | mcp.instructions | must | a done=false result is followed by another call on the same job_id (not judged while it may still be running, < 30 min) |
| `pass_context` | mcp.instructions | should | the request has no `no_shared_context`, `refers_outside` or `prompt_refers_outside` code |
| `delegate_for_one` | mcp.instructions | should | a run_tasks request is not `single_task` |
| `never_self` | mcp.instructions | must | a delegate does not pin `to` to the caller's own lane |
| `handle_simple_yourself` | mcp.instructions | should | blind spot (needs content) |
| `self_contained` | tool.run_tasks | should | no `thin_instruction` or `refers_outside` |
| `parallel_tasks` | tool.run_tasks | should | not `serial_chain` |
| `roster_lanes` | tool.run_tasks | must | the graph was not refused for lane, capability, model or effort (no verdict when the job is outside the window) |
| `model_only_hard` | tool.run_tasks | should | no `strong_model_pinned` |
| `heed_warning` | feedback.spec_warnings | must | the next run_tasks request in the session no longer carries a code the previous result actually returned in `spec_warnings` (trace field `warned`; refused calls return none) |
| `lead.envelope_only` | prompt.lead | must | a delegation reply parses as `delegate.v1` (code `bad_envelope` or `multiple_envelopes` otherwise) |
| `lead.max_tasks` | prompt.lead | must | the reply is not refused for too many tasks (`too_many_tasks`) |
| `lead.roster_names` | prompt.lead | must | the batch passes the roster check |
| `lead.new_ids` | prompt.lead | must | no reused task id |
| `lead.valid_deps` | prompt.lead | must | no unknown, duplicate or cyclic dependency |
| `lead.no_delegate_last` | prompt.lead | must | the last-round reply is an answer |
| `lead.model_only_needed` | prompt.lead | should | delegated tasks do not pin `model` |
| `lead.acceptance` | prompt.lead | should | every delegated task has `acceptance` |
| `lead.answer_directly` | prompt.lead | should | blind spot |
| `lead.no_false_claims` | prompt.lead | must | blind spot |
| `worker.quick` | prompt.worker | should | the worker finished before its timeout (lane failures such as usage_limit are not counted) |
| `worker.no_delegate` | prompt.worker | must | blind spot |
| `worker.report_evidence` | prompt.worker | should | blind spot |

Blind spots are listed, not guessed. A directive that can only be judged by reading prompts or answers stays out of the numbers.

### What the graph records for this

- MCP trace records and job `started` events carry `harness`: a fingerprint (`h` + 10 hex) of every harness text (`harnessVersion()` in `src/mcp/harnessText.ts`). It hashes one fingerprint per source: the MCP instructions, every registered tool's description and input schema (collected from the server's own `registerTool` calls, so no tool text can be missed), every `SPEC_RULES` guidance, and the lead and worker prompts. Verdicts are split `byVersion`, so a harness edit can be compared with `graph compare` on fresh traffic.
- run_tasks trace records carry `warned`: the `spec_warnings` codes the result actually returned.
- The loop engine writes a `lead_decision` event per lead reply: `kind` (answer, empty, delegate, invalid, rejected, closed), task counts, pinned models, tasks with acceptance, and `code` (`too_many_tasks`, `multiple_envelopes`, `bad_envelope`, or a refusal code). The problem text is never stored. The export folds the event into the lead's `tool_result` node as `arguments.decision` and `arguments.code`, without adding a node.
- One `graph analyze` reads each job and session once (`exportAll`), so the JSONL, the pictures and `analysis.json` agree. `agentctl graph harness` without a directory skips the SessionGraph analyzer and writes only `harness.html` and `harness.json`.
- Every node a verdict was observed at carries `arguments.harness = { "<directive>[:<code>]": "followed" | "not_followed" }`.

### Evidence, coverage and versions

- **Sample bar.** Every tally (per directive, per reader, per version) carries `n` (`applicable`), `followRate`, a Wilson 95% interval `ci95` and `enough` (n ≥ `HARNESS_MIN_SAMPLES`, the same 3 as `SPEC_THRESHOLDS.minGraphs`). Below the bar a rate is shown as "85% (n<3)" and never colored as a problem.
- **All k in a row.** `must` directives also report `passAllK` (k = 3): C(followed, 3) / C(n, 3), the share of 3-check subsets that were all followed, in the spirit of tau-bench's pass^k. Checks from one session are correlated, so it describes the sample; it is not a calibrated probability (`caveats` in the digestion says so).
- **Coverage.** `coverage` splits failed runs (unique job ids) into `explained` (a directive was not followed) and `unexplained`, counts unexplained runs per `reason` in `gaps`, and lists a reason seen in 2+ unexplained runs under `candidates`: a harness gap worth a new directive, or a lane to fix.
- **Per-source versions.** Traces and job `started` events also carry `harness_sources` (`harnessSourceHashes()`), one hash per source; the global `harness` is the hash of those hashes. Each observation gets the hash of its own directive's source (`sourceVersion`), and each directive reports `bySourceVersion`, so editing one source is credited only to that source's directives. Traces without per-source hashes appear as `unrecorded`.

### Effort: set it, choose it, measure it

- **Every lane pins effort.** The Claude preset passes `--effort` (requested, else `medium`), so a delegated Claude call never inherits the user's interactive setting. Codex passes `-c model_reasoning_effort=…`. Task-graph workers use `low` when the lane offers it.
- **Callers and the lead can choose it.** `agentctl_agents` lists each lane's `efforts`. The run_tasks and delegate `effort` fields say when to use each level, and the lead prompt lists effort levels per lane with the same guidance. `lead_decision` records `withEffort`, how many delegated tasks set their own effort.
- **Measure it on a fixed task set, not on live traffic.** Live traffic mixes task difficulty with settings.
  - `agentctl bench-effort --seed 12` drafts cases from recent jobs into the private `$AGENTCTL_HOME/bench/effort-cases.yaml`. It is real task text, so it never goes in the repo. Review the file: delete cases the lane cannot do and add `contains`/`regex` checks.
  - `agentctl bench-effort --lane claude --levels low,medium,high,xhigh` runs every case at every level, interleaved so cache and drift affect all levels alike. It reports pass rate, median output tokens, cost and time per level, and saves the numbers (no text) to `$AGENTCTL_HOME/bench/effort-<time>.json`.

### Reading and acting

| Evidence (`analysis.json → harness`) | Meaning | Move |
| --- | --- | --- |
| a `must` directive with `notFollowed` > 0 for one reader | that model does not take the line in | move the line to where that model reads it (tool description or schema over server instructions), or enforce it at the gate |
| a `should` directive rarely followed by every reader, and `after.notFollowed` fails no more than `after.followed` | the line costs attention and changes nothing | reword it or drop it; check with `graph compare` |
| `failLift` ≥ 1.5 | not following the line predicts failure | tighten it (escalation ladder above) |
| `heed_warning` not followed for a code | the fix sentence does not land | rewrite that `SPEC_RULES` guidance |
| `back[].notFollowed` empty with a recurring `reason` | no directive covers the failure: a lane problem (`worker:*`, `lead:*`) or a **harness gap** (`ambiguous_route`, a refusal code) | lanes: route around them. Gap: propose a new directive and its check, and add it to the registry |

The same evidence bar as `graph improve` applies: act only when `enough` is true, and read the interval. "5 of 6" has a 95% interval of roughly 44–97%. One run is an anecdote.

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
| Pictures (workflow and overview Mermaid, `graph.html`) | `src/graph/render.ts` |
| Harness registry, verdicts, digestion, back traces | `src/graph/harness.ts` |
| Harness pictures (`harness.html`, flow and back) | `src/graph/harnessRender.ts` |
| Harness texts and their fingerprint | `src/mcp/harnessText.ts` |
| CLI (`graph export/analyze/harness/improve/apply/compare`) | `src/graph/command.ts` |
| MCP descriptions, `spec_warnings`, content-free trace | `src/mcp/server.ts`, `src/mcp/trace.ts` |
| Pi tool pass-through | `integrations/pi/agentctl.ts` |
| Tests | `test/graph.test.ts`, `test/graphPromptBehavior.test.ts`, `test/graphHarness.test.ts`, `test/mcpServer.test.ts` |

Related: [AGENT-INTEGRATION.md](AGENT-INTEGRATION.md#improving-agentctl-from-real-usage-sessiongraph), [TURN-GRAPH.md](TURN-GRAPH.md) (memory-plane graphs), [SESSIONGRAPH-NIGHTLY.md](SESSIONGRAPH-NIGHTLY.md).
