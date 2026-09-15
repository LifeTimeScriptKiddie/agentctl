# agentctl

A CLI, TypeScript library, and Pi extension for routing tasks to local AI agent CLIs and coordinating bounded multi-step work.

## Install

Requires Node.js 20 or newer and at least one separately installed, authenticated agent CLI for live tasks. Model availability depends on your provider account; the shipped model roster is configurable and is not a promise of availability.

```sh
npm install -g @lifetimescriptkiddie/agentctl
agentctl --help
agentctl agents list
```

For Pi, install the package and restart Pi or reload extensions:

```sh
pi install npm:@lifetimescriptkiddie/agentctl
```

Then use `/agentctl` for help. The extension includes its own CLI; a separate global agentctl installation is unnecessary.

```text
/agentctl health
/agentctl route review this module
/agentctl ask --to codex explain this function
/agentctl orchestrate review this project
```

`route` and `delegate` choose a backend and execute the task. Use the CLI `route --dry-route` to inspect routing without execution.

`orchestrate` in Pi defaults to a dry-plan preview. `--run` executes a plan and can consume provider credits. Use `--budget` and `--max-replans` to bound execution. `--approve` authorizes gated operations; review the requested task before using it. A dry plan does not guarantee that all subsequent steps will succeed.

For a synthetic CLI check without an authenticated provider:

```sh
agentctl ask --to dry_run "hello" --format json
```

## Configuration and integrations

Use `agentctl --help` and each subcommand's `--help` for options. Agent presets live in `src/adapters/presets`; custom agent configuration can override defaults. See [model routing](docs/MODEL-ROUTING.md) and [Pi integration](docs/INTEGRATIONS.md).

The browser adapter is optional and requires Playwright plus an explicitly configured CDP browser. Automatic browser launch is disabled by default. The managed launch helper targets macOS; other platforms must provide their own CDP endpoint. Core subprocess backends depend on the corresponding CLI being available on PATH.

## Privacy and trust

This release contains source and synthetic tests, not personal sessions, browser profiles, captured pages, credentials, or the original development repository's history.

When you use agentctl, prompts and selected context go to the backend you choose. Child processes inherit your environment and can access credentials available to that backend. Capability declarations and approval checks are not an operating-system sandbox. Only use trusted backends, extensions, and configuration.

Agentctl can persist transcripts, provider session identifiers, quota state and orchestration records under `~/.agentctl` (override with `AGENTCTL_HOME`). Run directories may also contain prompts, traces and results. Use `agentctl sessions --help` to inspect session management options and store work in a private directory. There is no blanket no-retention guarantee; review or remove local state when finished.

Browser evidence is saved only when `AGENTCTL_CAPTURE_EVIDENCE=1`. `AGENTCTL_EVIDENCE_DIR` sets its destination. Captures can include screenshots, page HTML, prompts and answers. Text redaction is best-effort; screenshots and page content may still contain personal data. URL query strings and fragments are omitted from metadata. Never publish runtime directories or captured evidence without review.

## Development

```sh
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
```

The committed lockfile preserves reviewed dependency versions. Respect a 14-day dependency publication cooldown when refreshing it. The npm artifact contains compiled JavaScript and runtime assets; Python is not a runtime requirement.

## License

MIT. Dependencies remain under their respective licenses and are installed separately, not vendored into this repository.

## Local agent monitoring

AgentWatch's read-only collectors now live inside agentctl. They need no separate
AgentWatch installation, process, registry, or runtime dependency. agentctl owns
live operations; iseeagents remains the project for recorded workflow evidence.

```bash
agentctl monitor --once --json
agentctl monitor --table
agentctl monitor --statusline
agentctl watch --interval 5
agentctl monitor --feed "$HOME/.cache/agentctl/monitor.json" --interval 5
```

Monitoring currently requires macOS, an ordinary current-user account, and the
host's `ps`, `lsof`, and `nettop` commands. It does not require elevated privileges.
`monitor` defaults to one JSON snapshot. `watch` requires an interactive terminal;
Ctrl-C or SIGTERM stops refreshes. Feed/watch collection is sequential, with a
3–3600 second refresh interval (default 5). Shutdown interrupts the wait between
samples; an in-progress collector may finish before shutdown, bounded by its
command timeout. A snapshot takes approximately three seconds for network sampling.

The table shows **observed agent families**, including manually launched agents.
Network totals cover each family's matched process trees. They are not per-job
measurements, proof of progress, provider identification, or billing data. No PID
is treated as authorization to control an observed process. Use `agentctl status`
for controller run state; dispatch, cancellation, permissions, and existing chat
commands retain their existing paths. Exact invocation correlation and automatic
iseeagents event export are not implemented by this migration.

### Snapshot contract and privacy

JSON retains AgentWatch schema 1 for existing consumers: `generated_at`, host UID,
collector status, sampling mode/window, and agent-family process/byte fields.
Consumers must check `generated_at` for freshness and collector status for
availability; zero bytes after collector failure do not mean zero traffic.
`state: unknown` takes precedence over the legacy `activity` field. Legacy
`activity: active` means recent network/session evidence only, never verified job
progress. The table calls this a `signal`. Family totals must not be assigned to
individual parallel workers. Comet traffic remains excluded from AI activity.

Only session-file metadata is inspected; session bodies and command arguments are
never emitted. Model enrichment only probes loopback listener ports discovered
for matched current-user processes. `AGENTCTL_MONITOR_OLLAMA_PORT` and
`AGENTCTL_MONITOR_LMSTUDIO_PORT` select a discovered port; legacy
`AGENTWATCH_OLLAMA_PORT` / `AGENTWATCH_LMSTUDIO_PORT` aliases remain accepted.

Feed files use atomic replacement and mode `0600`. Newly created feed directories
use `0700`; existing parent directory permissions are left intact. No feed file is
written unless requested. Collector failures appear as unknown/warnings; fatal
collection errors stop the command and leave an existing feed's timestamp intact.

### DesktopMon migration

DesktopMon installations that invoke `node ENTRY --once --json` can point their
configured entrypoint at this package's built `dist/monitor/compat.js`:

```bash
node /path/to/agentctl/dist/monitor/compat.js --once --json
```

This is a compatibility entrypoint within agentctl, not another installed product.
It shares the `monitor` options and collector implementation. Existing consumers
can also read a feed produced by `agentctl monitor --feed`. No existing DesktopMon
configuration or background service is changed by building this package.

Library users can import `collectMonitorOutput`, `MonitorOutput`, `runFeed`, and
`writeFeedAtomic` from the package root. The standalone AgentWatch control plane,
registration store, dispatch adapters, and conversation UI were not imported;
agentctl's existing control and chat implementations remain authoritative.
