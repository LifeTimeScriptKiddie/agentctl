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
