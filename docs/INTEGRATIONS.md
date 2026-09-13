# Pi integration

Install with `pi install npm:@lifetimescriptkiddie/agentctl`. The package registers `/agentctl` and launches the bundled JavaScript CLI with the current Node executable.

Supported commands: `help`, `health`, `ask --to <agent> <prompt>`, `route <task>`, `delegate <task>`, and `orchestrate <goal>`.

Orchestration defaults to a dry-plan preview. Pass `--run` to execute. Optional flags: `--orchestrator`, `--orchestrator-model`, `--budget`, `--max-replans`, `--resume`, `--approve`.

Backends must be installed and authenticated separately. Check `/agentctl health` first. The Pi worker preset enables read tools only; this is a tool configuration, not a sandbox for third-party extensions. Configure provider/model IDs to match your account.

Pi's package manifest points to `dist/pi/agentctl.js`. Rebuild after source changes before testing a local installation. CLI failures with JSON output are displayed using their structured error instead of hiding the error behind a child-process failure.
