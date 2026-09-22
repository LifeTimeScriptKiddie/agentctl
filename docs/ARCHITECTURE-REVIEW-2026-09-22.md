# agentctl architecture review and remediation plan (2026-09-22)

Scope: `src/` at commit `7090f6f` (≈17k LOC TS). Baseline: `vitest` 460 passed / 3 skipped; `tsc --noEmit` **fails** (1 error).

## Findings

Severity: **C** critical, **H** high, **M** medium, **L** low.

| # | Sev | Area | Flaw | Evidence |
|---|-----|------|------|----------|
| F1 | C | memory serve | No authentication. Identity (`x-agentctl-user-id`, groups, clearance) is taken from client headers. Any caller can claim `confidential` clearance and any group. | `src/memory/serve.ts` `authFromHeaders` |
| F2 | C | memory serve | Fail-open ACL: missing identity headers → `auth = null` → `canReadMemory` returns `true` for every record (private included). | `src/memory/authContext.ts` `canReadMemory` |
| F3 | H | memory serve | CSRF / DNS-rebinding: POST bodies are `JSON.parse`d regardless of `content-type`, no Origin/Host check. A web page can `fetch('http://127.0.0.1:8741/v1/memory/write', {body: ..., mode: 'no-cors'})` with `text/plain`. | `serve.ts` body handling |
| F4 | H | memory serve | `human_approved: true` is a client-asserted body flag; any caller can promote memories. | `/v1/memory/accept` |
| F5 | H | memory serve | No request body size cap (memory DoS). `/v1/turn` with `run_model` spends model tokens for any caller and skips the approval gate. | `readBody`, `/v1/turn` |
| F6 | H | layering | Every CLI command is implemented twice: text path in `commands.ts`, JSON path in `api.ts`. They have drifted (see F7). `api.ts` ⇄ `commands.ts` import each other (cycle); `memory/turnModelGenerate.ts` imports the CLI layer. | `api.ts:17-26`, `commands.ts:45-52` |
| F7 | H | drift | Consequences of F6: `orchestrate --format json --resume` never resumes (JSON path never writes the run file); JSON route/delegate/orchestrate skip `route-log.jsonl` and `hallucination-log.jsonl`; `orchestrationRunPath` and the orchestrator default (`'codex'` literal vs `DEFAULT_ORCHESTRATOR_AGENT`) are duplicated. | `api.ts:424,447` vs `commands.ts:894,926` |
| F8 | M | exit codes | `ask --to all` returns exit 0 even when every agent fails (both paths). | `commands.ts:475`, `api.ts:284` |
| F9 | M | state | `limits.json` lost updates: each adapter loads the map at call start and saves its own copy at the end. In a fan-out, the last writer erases other agents' cap records. Temp file name is per-pid, so parallel writers in one process share it. | `adapters/subprocess.ts:160-209`, `core/limitStore.ts:saveLimits` |
| F10 | M | state | Orchestration resume file is keyed by `sha1(goal)` only, so the same goal in two repos/orchestrators collides; write is non-atomic. Unbounded-budget waves call `onStep` only after the whole wave, so a crash mid-wave loses finished steps. | `commands.ts:894`, `core/orchestrator.ts:442-456` |
| F11 | M | safety | Approval is a regex over prompt text only. Orchestrated steps that declare `needs: [canPublish]` run without `--approve` if the wording avoids the regex. | `approval.ts`, `commands.ts:379` |
| F12 | M | neutrality | "Adding a backend is a preset, not code" does not hold: the registry picks adapter classes by preset *name* (`agy`, `agy_image`); status hides agents by hard-coded name; the router and escalation hard-code agent names and model IDs. | `adapters/registry.ts:64`, `core/orchestrateRuntime.ts:4`, `core/router.ts` |
| F13 | L | exec choke-point | `memory/remote.ts` and `memory/layaEvidence.ts` call `spawnSync` directly, bypassing `util/exec.ts` and its test guard. `remote.ts` passes an unvalidated host to `ssh` (a host beginning with `-` is parsed as an option). | `memory/remote.ts:27` |
| F14 | L | hygiene | `tsc --noEmit` fails; version string duplicated in `cli.ts` vs `package.json`; dead `resolveRouting` params; empty comment blocks left from the removed LLM tiebreak. | `memoryUsageExport.ts:42`, `cli.ts:33` |
| F16 | M | tests | The suite is not hermetic: it fails wholesale when `AGENTCTL_WORKER_DEPTH` is set in the environment (for example when an agentctl worker runs `vitest`). | found while running P0 through a worker |
| F15 | L | design | `OpenMemoryStore = MemoryStore \| PostgresMemoryStore` is a union, not an interface; the two stores can drift silently. | `memory/openMemoryStore.ts` |

## Recommendations

1. **Make the gatekeeper a real gatekeeper.** Use a bearer token, fail closed on missing identity, require JSON content-type, check Host/Origin, cap body size, and gate human approval on reviewer group membership.
2. **Use one pipeline and two renderers.** `api.ts` becomes the only command implementation. `commands.ts` renders its result as text or JSON. Shared building blocks move to `core/`, so the import graph becomes `cli → commands → api → core/adapters` with no cycles.
3. **Make shared state writes merge-safe.** Re-read then merge before each write, use unique temp files, and scope resume keys.
4. **Gate on declared capability as well as regex.** A step that declares `canPublish` needs `--approve`.
5. **Move backend-specific facts into presets.** Start with adapter-class selection and visibility. The router model catalog is the larger follow-up.

## Status (2026-09-22)

P0–P4 are implemented on branch `arch-review-fixes`, one commit per phase. Each phase was implemented by Cursor (`gpt-5.6-luna-high`) through `agentctl ask` and reviewed by Claude. Final state: `tsc` clean, 482 tests passed / 3 skipped (was 460 with `tsc` failing). Review fixes Claude made on top of the worker output:
- P1: an empty `AGENTCTL_SERVE_TOKEN` was accepted as a match for `Bearer ` (fixed and tested); the approval text now joins goal and query with a newline.
- P2b: removed a duplicated JSON branch in `cmdStatus`.

Known limits:
- `updateLimits` narrows the lost-update window to microseconds, but it is not a cross-process lock.
- A user `agents.yaml` that overrides `claude`/`agy_image` without `hideWhenUnavailable` now keeps those agents visible.
- Text-mode `orchestrate --resume` now prints `resuming: …` as a stderr `note:` line.

## Execution plan

Each phase is one bounded worker task. Every phase must end with `npx tsc --noEmit` clean and `npx vitest run` green. Each phase adds tests for its new behavior and gets its own commit.

### P0: baseline hygiene (F14)
- Fix the `noUncheckedIndexedAccess` error in `src/memory/memoryUsageExport.ts` `parseSinceToMs` (`rel[1]`/`rel[2]` may be undefined).
- `cli.ts`: read the version from `package.json` (via `createRequire` or `readFileSync` + `new URL('../package.json', import.meta.url)`) rather than hard-coding `0.2.0`.
- Remove the unused `_opts` parameter from `resolveRouting` in `api.ts`, and delete the orphaned empty comment blocks in `commands.ts` (the "Optional LLM tiebreak" doc comment with no function, and the blank lines after `route(...)` calls).
- Add `"check": "tsc --noEmit && vitest run"` to package.json scripts.

### P1: memory server hardening (F1–F5)
In `src/memory/serve.ts` (+ tests in `test/memoryServe.test.ts` / new `test/memoryServeAuth.test.ts`):
1. **Token auth**: if `AGENTCTL_SERVE_TOKEN` is set, every route except `GET /health` requires `Authorization: Bearer <token>` (compare with `crypto.timingSafeEqual` on equal-length buffers), else 401.
2. **Fail closed on identity**: when no identity header is present, return 401 `identity_required` unless `AGENTCTL_SERVE_ALLOW_ANON=1`. Anonymous mode keeps today's single-user behavior. The server then trusts identity headers only because the token authenticates the caller as the trusted gateway. Document this in the server's header comment.
3. **Refuse unsafe bind**: `startMemoryServer` throws if `host` is not loopback (`127.0.0.1`, `::1`, `localhost`) and `AGENTCTL_SERVE_TOKEN` is unset.
4. **CSRF / rebinding**: POST requires `content-type` starting with `application/json` (else 415). If an `Origin` header is present and not in `AGENTCTL_SERVE_ALLOWED_ORIGINS` (comma list, default empty), return 403. When bound to loopback, reject a `Host` header whose hostname is not loopback (403).
5. **Body cap**: `readBody` rejects bodies over 1 MiB (`AGENTCTL_SERVE_MAX_BODY` override) with 413 and stops reading.
6. **Human approval**: `/v1/memory/accept` requires a non-null auth context. If `AGENTCTL_MEMORY_REVIEWER_GROUPS` is set, the caller must belong to one of those groups (else 403 `reviewer_required`).
7. **Validate clearance header** with the zod `classification` enum (invalid → 400) instead of an unchecked cast.
8. **Turn approval**: `/v1/turn` with `run_model` runs `assertApproved(goal + query, false)` and returns 403 `approval_required` on a match.

### P2a: break the cycle, no behavior change (F6)
- Move `loadRegistry`, `RegistryOptions` → `src/core/loadRegistry.ts`.
- Move `AskResult`, `askOne`, `askAll`, `fanoutTargets`, `boundedEvidence`, `chatRequest` → `src/core/ask.ts`.
- Move `ResolvedSession`, `resolveSessionScope`, `resolveSession`, `persistSessionExchange`, `appendSessionExchange`, `renderTranscript` → `src/core/sessionFlow.ts`.
- Move `OrchCallPhase`, `OrchestrateHooks`, `createOrchestrateDeps`, `RunOrchestrateGoalOpts`, `runOrchestrateGoal`, `orchestrationRunPath`, `logRoute`, `logHallucinationIncidents` → `src/core/orchestrateFlow.ts` (one `orchestrationRunPath`).
- `commands.ts` re-exports these names so `index.ts`, `repl.ts`, tests, and the Pi integration keep compiling. `api.ts` and `memory/turnModelGenerate.ts` import from `core/*`, never from `commands.ts`.
- Acceptance: `grep -n "from './commands.js'" src/api.ts` and `grep -n "commands.js" src/memory` return nothing; all tests pass unchanged.

### P2b: one pipeline (F6, F7, F8)
- `cmdAsk` / `cmdRoute` / `cmdDelegate` / `cmdOrchestrate` / `cmdStatus` / `cmdAgents` call the `api.ts` function first. For `json`, emit the envelope. For `text`, render the returned structure with today's exact colors and wording (warnings → `io.err` yellow `note: …`, errors → `io.err` red).
- Move route logging into `agentRoute` (and the routed branch of `agentDelegate`). Move resume-file persistence (`onStep` writer + delete on `done`) and `logHallucinationIncidents` into `agentOrchestrate`. Both modes then share them.
- `agentOrchestrate` default orchestrator = `DEFAULT_ORCHESTRATOR_AGENT`.
- `agentAsk` with `to: 'all'`: exitCode 0 if all ok, 1 if any failed. Text mode follows it.
- Add tests: JSON orchestrate with `resume` skips passed steps (run file written by a prior JSON run); fan-out with a failing adapter exits 1; route-log written in JSON mode (use `AGENTCTL_HOME` tmp dir).

### P3: state + safety correctness (F9, F10, F11, F13)
- `limitStore`: add `updateLimits(fn: (m) => LimitMap)`, which re-reads the file, applies `fn`, and writes atomically with a unique temp name (`${path}.${pid}.${randomUUID()}.tmp`). `SubprocessAdapter.invoke` uses it for mark/clear so concurrent adapters merge. Test: two interleaved marks both survive.
- Orchestration run path = `sha1(JSON.stringify({goal, cwd: process.cwd(), orchestrator}))`. Store `goal` in the file and ignore it on mismatch. Write atomically (tmp + rename).
- `runOrchestration` unbounded path: call `done.set` / `onStep` as each step settles (per-promise `.then`), not after `Promise.all`. Test: `onStep` fires for a fast step before a slow sibling finishes.
- Approval: `approveStep` receives the `PlanStep`. It blocks when `findDestructive(instruction)` hits **or** `step.needs` includes `canPublish`, unless approved. Update the call site and tests.
- `memory/remote.ts`: reject a host beginning with `-` or containing whitespace, and pass `--` before the host to `ssh`.
- Tests hermetic (F16): add a vitest `setupFiles` entry (e.g. `test/setup.ts`, registered in `vitest.config.ts`) that deletes `AGENTCTL_WORKER_DEPTH` from `process.env` before each test file. Tests that exercise the nested-worker guard set it explicitly.

### P4: preset-driven backend facts (part of F12)
- Add an optional `adapter` field to `PresetSchema` (`z.enum(['subprocess','agy','agy_image']).nullable().default(null)`). The registry chooses `AgyAdapter`/`AgyImageAdapter` by that field and falls back to the current name check for back-compat. Set it in `agy.yaml` / `agy_image.yaml`.
- Add an optional `hideWhenUnavailable: boolean` to `PresetSchema` (default false). Set it in `claude.yaml` and `agy_image.yaml`. `visibleAgentNames` reads it from presets rather than the hard-coded set (change its signature to take the registry, or a `Set` built from presets).
- Regenerate JSON specs (`npm run gen:specs`) if the schema test requires it.

### Deferred (needs design sign-off, not in this pass)
- **Router model catalog → presets** (rest of F12): move `suggestModel`/`defaultWorkerModel`/`escalateWorker` tables into per-preset `models.tiers` and `routing.prefer` blocks. This is large, changes `router.test.ts` expectations wholesale, and is the core product behavior, so it needs its own reviewed change.
- **Memory store interface** (F15): define `MemoryStorePort` and make both stores implement it.
- **Remaining import cycles** (madge): `memory/store` ⇄ `memoryWriteGraph` / `turnGraph`, and `repl` ⇄ `tui/blessedChat`.
- **Health probe cost**: every CLI invocation probes all presets. Consider an on-disk TTL cache.
