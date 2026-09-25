# @lifetimescriptkiddie/shared-ptr-contract

The wire contract of [shared_ptr](https://github.com/LifeTimeScriptKiddie/shared_ptr), the team-memory
server for AI agents. The server and its clients (the shared_ptr CLI, its MCP server, and agentctl) all
validate their messages against these zod schemas.

- `.` holds the schemas for every `/v1` route, `ROUTES`, `CONTRACT_VERSION`, and the resume-briefing packet.
- `./format` holds how a `/v1/turn` response is placed in a prompt. Untrusted memory is quoted.
- `./local` holds the same-machine conventions: the home directory and the owner-token file.

Clients check `GET /v1/meta` and refuse a server that speaks a different contract version.
Node.js 20+, ESM only; `zod` ^4 is a peer dependency.
