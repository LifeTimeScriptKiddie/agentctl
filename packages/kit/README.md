# @lifetimescriptkiddie/agentctl-kit

Small security and state helpers shared by [agentctl](https://github.com/LifeTimeScriptKiddie/agentctl)
and [shared_ptr](https://github.com/LifeTimeScriptKiddie/shared_ptr). There is only one copy of this
code, so security fixes land in both at once.

| Import | What |
|---|---|
| `…/redact` | strip credential-shaped strings before anything is logged or written |
| `…/untrusted` | quote untrusted text (memory, model output) so a model treats it as data |
| `…/destructive` | detect destructive or outward-facing intent (`rm -rf`, `git push`, …) |
| `…/privateFs` | 0700 directories and atomic 0600 files |
| `…/appHome` | an app's state directory (`~/.<name>`, overridable by an env var) |

Node.js 20+, ESM only.
