# Hermes integration

Agentctl supports **Hermes as an opt-in Docker worker**. Agentctl remains the controller and invokes
Hermes in one-shot mode inside an existing persistent container.

This direction is supported:

```text
Pi / terminal / IDE → agentctl → docker exec → Hermes → result
```

Do not call agentctl recursively from a Hermes process that agentctl launched. The Docker adapter
injects `AGENTCTL_WORKER_DEPTH=1`, and nested orchestration is designed to fail closed.

## Why Hermes is opt-in

Hermes one-shot mode loads tools, memory, rules, and `AGENTS.md`, and its own help states that
approval prompts are bypassed in one-shot mode. A generic packaged lane therefore cannot safely
assume which tools or host paths an operator intends to expose.

The supplied example enables only the verified `web` toolset. It is a research lane with network
access and no declared repository-write capability. Add file, terminal, code-execution, browser, or
computer-use tools only after updating the capability declaration and the applicable approval policy.

## Prerequisites

1. Docker is running.
2. A persistent Hermes container is running and authenticated.
3. The preferred container name is `hermes-gateway-local`. The adapter can otherwise discover a
   non-transient container created from `nousresearch/hermes-agent`.
4. The `hermes` executable is available inside the container.

Verify without an agentctl call:

```sh
docker ps --filter name=hermes-gateway-local
docker exec hermes-gateway-local hermes --version
docker exec hermes-gateway-local hermes tools list
```

Agentctl never starts, updates, authenticates, or removes the Hermes container.

## Configure the lane

Put the following reviewed configuration at `~/.agentctl/agents.yaml`:

```yaml
agents:
  hermes:
    name: hermes
    family: docker_exec
    transport: docker_exec
    parse: text
    containerResolve:
      preferName: hermes-gateway-local
      byImage: nousresearch/hermes-agent
      rejectAutoremove: true
    toolsets: web
    capabilities:
      canReadFiles: false
      canWriteFiles: false
      canRunShell: false
      canAccessNetwork: true
      canUseBrowser: false
      canModifyRepo: false
      canPublish: false
```

The same configuration is available in [`examples/agents-hermes.yaml`](../examples/agents-hermes.yaml).

`$AGENTCTL_HOME/agents.yaml` is the operator-level configuration. A repository-local
`./agents.yaml` must be reviewed and explicitly trusted:

```sh
agentctl config trust /absolute/path/to/agents.yaml
```

## Verify and use

```sh
agentctl agents list
agentctl agents health
agentctl ask --to hermes "Summarize the public documentation for Open5GS registration flows."

# Override Hermes's configured provider/model for one call when needed:
agentctl ask --to hermes --model openai-codex/gpt-5.6-luna "Reply with the selected model name."
```

Expected health detail:

```text
hermes via hermes-gateway-local
```

Hermes is not selected automatically by the default router. Pin it with `--to hermes` when you want
that lane.

## Project-file access

`docker exec` does not make host files visible. Hermes can read only paths already mounted into its
container. The adapter currently uses the container’s configured working directory; it does not map
the caller’s host working directory automatically.

Before enabling a file-capable lane:

1. Mount only the required project or a disposable worktree into the persistent container.
2. Confirm the container working directory points at that mount.
3. Pin a Hermes toolset that contains only the required tools.
4. Change `canReadFiles`, `canWriteFiles`, `canRunShell`, and `canModifyRepo` to match reality.
5. Use a separate adapter name, such as `hermes_repo`, so the web-only lane remains constrained.

Do not label a file or terminal lane read-only. Agentctl uses capability declarations to decide
which orchestration roles are permitted, but they are declarations rather than a Docker sandbox.

## Failure guide

| Failure | Resolution |
| --- | --- |
| `unknown adapter 'hermes'` | Add the opt-in `agents.yaml`; Hermes is excluded from the default registry |
| `no usable Hermes container` | Start the persistent container or adjust `preferName`/`byImage` |
| Transient `*-cli-run-*` container rejected | Keep a persistent gateway container running; transient auto-remove containers are intentionally ignored |
| Hermes returns authentication failure | Complete authentication inside Hermes before invoking it through agentctl |
| Hermes reports a missing provider CLI | Hermes's configured provider is unavailable inside the container; install it there or pass a working `--model provider/model` override |
| Hermes cannot find a file | Verify the host path is mounted and reachable from the container working directory |
| Tool is missing | Run `hermes tools list` in the container and pin a valid toolset; do not fall back silently to all tools |

## Current verification boundary

The Docker adapter has unit coverage for preferred-name discovery, image fallback, transient-container
rejection, toolset arguments, health reporting, and result parsing. A release smoke test should also
run `agentctl agents health` and one harmless explicit `ask --to hermes` against the operator’s
authenticated container. Live availability depends on that external container and provider account.
