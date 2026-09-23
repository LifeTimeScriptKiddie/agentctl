import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

/** Packaged agentctl defaults for plan/verify/synth. */
const DEFAULT_ORCHESTRATOR = "codex";
const DEFAULT_ORCHESTRATOR_MODEL = "gpt-5.6-sol";

interface JsonEnvelope {
  ok: boolean;
  exitCode: number;
  command: string;
  warnings: string[];
  result?: unknown;
  error?: string;
}

async function runAgentctl(args: string[], cwd: string, timeoutMs = 600_000): Promise<JsonEnvelope> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [fileURLToPath(new URL("../cli.js", import.meta.url)), args[0]!, "--format", "json", ...args.slice(1)], {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
    }));
  } catch (error) {
    const output = (error as { stdout?: string }).stdout;
    if (!output?.trim()) throw error;
    stdout = output;
  }
  const line = stdout.trim().split("\n").pop() ?? stdout.trim();
  return JSON.parse(line) as JsonEnvelope;
}

/** `agentctl jobs …` always prints one JSON envelope; it takes no --format flag. */
async function runJobsCli(args: string[], cwd: string, timeoutMs = 120_000): Promise<JsonEnvelope> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [fileURLToPath(new URL("../cli.js", import.meta.url)), "jobs", ...args], {
      cwd, maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs,
      env: { ...process.env, AGENTCTL_CALLER: process.env.AGENTCTL_CALLER ?? "pi" },
    }));
  } catch (error) {
    const output = (error as { stdout?: string }).stdout;
    if (!output?.trim()) throw error;
    stdout = output;
  }
  const line = stdout.trim().split("\n").pop() ?? stdout.trim();
  return JSON.parse(line) as JsonEnvelope;
}

function formatWarnings(warnings: string[]): string {
  return warnings.length ? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
}

function resolveBriefingWorkspace(explicit?: string): string | undefined {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  const env = process.env.AGENTCTL_BRIEFING_WORKSPACE?.trim();
  return env || undefined;
}

function applyWorkerBriefingArgv(argv: string[]): string[] {
  if (argv.some((a, i) => a === "--briefing-workspace" && argv[i + 1])) return argv;
  const ws = resolveBriefingWorkspace();
  if (!ws) return argv;
  return ["--briefing-workspace", ws, ...argv];
}

function defaultMemoryWorkspace(explicit?: string): string {
  return resolveBriefingWorkspace(explicit) ?? "agentctl-pilot";
}

/** Parse leading worker flags without ever interpolating a shell command. */
export function parseWorkerArgs(raw: string): string[] {
  const values = new Set([
    '--to', '--model', '--effort', '--timeout', '--session',
    '--briefing-workspace', '--session-scope', '--gateway-url',
  ]);
  const switches = new Set(['--dry-route', '--explain', '--resume', '--approve', '--verbose']);
  const argv: string[] = [];
  let rest = raw.trim();
  const take = (): string => {
    const match = rest.match(/^(?:"([^"]*)"|'([^']*)'|(\S+))(?:\s+|$)/);
    if (!match) throw new Error('Unterminated quoted option');
    rest = rest.slice(match[0].length).trimStart();
    return match[1] ?? match[2] ?? match[3]!;
  };
  while (rest.startsWith('--')) {
    const flag = take();
    if (flag === '--') break;
    if (values.has(flag)) {
      if (!rest || rest.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      argv.push(flag, take());
    } else if (switches.has(flag)) argv.push(flag);
    else throw new Error(`Unsupported worker flag: ${flag}`);
  }
  if (!rest) throw new Error('A task prompt is required');
  if ((rest.startsWith('"') && rest.endsWith('"')) || (rest.startsWith("'") && rest.endsWith("'"))) rest = rest.slice(1, -1);
  return [...argv, '--', rest];
}

interface OrchestrateFlags {
  dryPlan: boolean;
  run: boolean;
  approve: boolean;
  resume: boolean;
  orchestrator: string;
  orchestratorModel: string;
  budget?: string;
  maxReplans?: string;
  /** Start as a durable background job and return its id (see /agentctl job). */
  background: boolean;
  goal: string;
}

function parseOrchestrateArgs(raw: string): OrchestrateFlags | { error: string } {
  const tokens = raw.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((t) => t.replace(/^"|"$/g, "")) ?? [];
  let dryPlan = false;
  let run = false;
  let approve = false;
  let resume = false;
  let orchestrator = DEFAULT_ORCHESTRATOR;
  let orchestratorModel = "";
  let budget: string | undefined;
  let maxReplans: string | undefined;
  let background = false;
  const goalParts: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--dry-plan") {
      dryPlan = true;
      continue;
    }
    if (t === "--run") {
      run = true;
      continue;
    }
    if (t === "--approve") {
      approve = true;
      continue;
    }
    if (t === "--resume") {
      resume = true;
      continue;
    }
    if (t === "--bg" || t === "--background") {
      background = true;
      continue;
    }
    if (t === "--orchestrator") {
      const v = tokens[++i];
      if (!v) return { error: "Usage: --orchestrator <agent>" };
      orchestrator = v;
      continue;
    }
    if (t === "--orchestrator-model") {
      const v = tokens[++i];
      if (!v) return { error: "Usage: --orchestrator-model <model>" };
      orchestratorModel = v;
      continue;
    }
    if (t === "--budget") {
      const v = tokens[++i];
      if (!v) return { error: "Usage: --budget <usd>" };
      budget = v;
      continue;
    }
    if (t === "--max-replans") {
      const v = tokens[++i];
      if (!v) return { error: "Usage: --max-replans <n>" };
      maxReplans = v;
      continue;
    }
    if (t.startsWith("-")) {
      return { error: `Unknown flag '${t}'. Try /agentctl help` };
    }
    goalParts.push(t);
  }

  const goal = goalParts.join(" ").trim();
  if (!goal) {
    return {
      error:
        "Usage: /agentctl orchestrate [--dry-plan|--run] [--orchestrator codex] [--orchestrator-model gpt-5.6-sol] <goal>",
    };
  }

  // Default stays dry-plan (safe preview). --run executes. If both, --run wins.
  if (!dryPlan && !run) dryPlan = true;
  if (run) dryPlan = false;

  return { dryPlan, run, approve, resume, orchestrator, orchestratorModel, budget, maxReplans, background, goal };
}

function formatOrchestration(
  env: JsonEnvelope,
  dryPlan: boolean,
  orchestrator: string,
  orchestratorModel: string,
): string {
  const orch = env.result as
    | {
        status?: string;
        plan?: { steps?: Array<{ id: string; instruction: string; agent?: string; model?: string }> };
        synthesis?: string | null;
        error?: string;
      }
    | undefined;
  const steps = orch?.plan?.steps ?? [];
  const plan = steps
    .map((s) => {
      const who = s.agent ? ` → ${s.agent}${s.model ? `:${s.model}` : ""}` : "";
      return `- ${s.id}${who}: ${s.instruction}`;
    })
    .join("\n");
  const orchLabel = `${orchestrator}/${orchestratorModel || "configured default"}`;
  const header = dryPlan
    ? `dry-plan (${steps.length} steps; orchestrator ${orchLabel})`
    : `orchestrate ${orch?.status ?? (env.ok ? "ok" : "failed")} (${steps.length} steps; orchestrator ${orchLabel})`;
  const synth = !dryPlan && orch?.synthesis ? `\n\nSynthesis:\n${orch.synthesis}` : "";
  const err = env.error || orch?.error ? `\n\nError: ${env.error ?? orch?.error}` : "";
  return `${header}:\n${plan || "(empty)"}${synth}${err}${formatWarnings(env.warnings)}`;
}

function parseFlag(rest: string, name: string): string | undefined {
  const m = rest.match(new RegExp(`(?:^|\\s)${name}\\s+(\\S+)`));
  return m?.[1];
}

function parseQuoted(rest: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s+"([^"]*)"`);
  const m = rest.match(re);
  return m?.[1];
}

async function execMemoryCli(argv: string[], cwd: string): Promise<string> {
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  try {
    const { stdout } = await execFileAsync(process.execPath, [cli, "memory", ...argv], {
      cwd,
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const output = (error as { stdout?: string }).stdout;
    if (output?.trim()) return output.trim();
    throw error;
  }
}


/**
 * Tools Pi's model can call on its own (no `/agentctl` needed). They mirror the
 * `agentctl mcp` tools and run through the same `agentctl jobs` CLI, so the
 * approval gates and caller exclusion (`pi`) apply. Approval is never passed:
 * destructive requests come back as approval_required for the human to run.
 */
const TOOL_GUIDELINES = [
  "Use agentctl_delegate to hand a self-contained task to another local agent (codex for code edits/tests, claude for deep review or writing, cursor for fast repo Q&A, agy for web research) when that agent fits better than you, or for an independent second opinion.",
  "Use agentctl_orchestrate for multi-step work that benefits from plan → parallel workers → verification; it returns a job id — poll it with agentctl_job_wait.",
  "Do not use agentctl for simple edits or questions you can answer directly.",
];

function toolText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

async function startAndWait(argv: string[], cwd: string, waitSeconds: number): Promise<unknown> {
  const started = await runJobsCli(["start", ...argv, "--caller", "pi"], cwd);
  const id = (started.result as { id?: string } | undefined)?.id;
  if (!started.ok || !id) return { error: started.error ?? "could not start job" };
  if (waitSeconds <= 0) return { job_id: id, done: false, next: `call agentctl_job_wait with job_id "${id}"` };
  const waited = await runJobsCli(["wait", id, "--timeout", String(waitSeconds)], cwd, (waitSeconds + 30) * 1000);
  const r = waited.result as { done?: boolean; job?: { status?: string }; result?: unknown } | undefined;
  return r?.done
    ? { job_id: id, done: true, status: r.job?.status, result: r.result }
    : { job_id: id, done: false, status: r?.job?.status, next: `call agentctl_job_wait with job_id "${id}"` };
}

export function registerAgentctlTools(pi: ExtensionAPI): void {
  if (typeof (pi as { registerTool?: unknown }).registerTool !== "function") return;
  const str = (description: string) => ({ type: "string", description });

  pi.registerTool({
    name: "agentctl_delegate",
    label: "agentctl delegate",
    description: "Route a task to the best-fit local agent (or `to`) and run it once. Returns the result, or a job_id if still running.",
    promptSnippet: "agentctl_delegate: hand a task to another local agent (codex/claude/cursor/agy)",
    promptGuidelines: TOOL_GUIDELINES,
    parameters: {
      type: "object",
      properties: {
        task: str("Self-contained task for the worker, including the context it needs."),
        to: str("Optional agent to pin: codex, codex_write, claude, cursor, agy."),
        wait_seconds: { type: "integer", minimum: 0, maximum: 300, description: "How long to wait here (default 120)." },
      },
      required: ["task"],
    } as never,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params as { task: string; to?: string; wait_seconds?: number };
      const argv = ["delegate", ...(p.to ? ["--to", p.to] : []), p.task];
      return toolText(await startAndWait(argv, ctx.cwd, p.wait_seconds ?? 120));
    },
  } as never);

  pi.registerTool({
    name: "agentctl_orchestrate",
    label: "agentctl orchestrate",
    description: "Plan → route steps to workers → verify → synthesize, as a background job. Returns a job_id to poll with agentctl_job_wait.",
    promptSnippet: "agentctl_orchestrate: multi-step plan/execute/verify across local agents (background job)",
    promptGuidelines: TOOL_GUIDELINES,
    parameters: {
      type: "object",
      properties: {
        goal: str("The overall goal, with the context workers need."),
        dry_plan: { type: "boolean", description: "Return the plan without executing it." },
      },
      required: ["goal"],
    } as never,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params as { goal: string; dry_plan?: boolean };
      const argv = ["orchestrate", ...(p.dry_plan ? ["--dry-plan"] : []), p.goal];
      return toolText(await startAndWait(argv, ctx.cwd, 0));
    },
  } as never);

  pi.registerTool({
    name: "agentctl_job_wait",
    label: "agentctl job wait",
    description: "Wait for an agentctl job; returns the result when done, else its status. Call again until done.",
    parameters: {
      type: "object",
      properties: {
        job_id: str("Id returned by agentctl_delegate / agentctl_orchestrate."),
        wait_seconds: { type: "integer", minimum: 0, maximum: 300, description: "Default 60." },
      },
      required: ["job_id"],
    } as never,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params as { job_id: string; wait_seconds?: number };
      const secs = p.wait_seconds ?? 60;
      const r = await runJobsCli(["wait", p.job_id, "--timeout", String(secs)], ctx.cwd, (secs + 30) * 1000);
      return toolText(r.ok ? r.result : { error: r.error });
    },
  } as never);

  pi.registerTool({
    name: "agentctl_job_cancel",
    label: "agentctl job cancel",
    description: "Cancel a running agentctl job.",
    parameters: { type: "object", properties: { job_id: str("Job id.") }, required: ["job_id"] } as never,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const r = await runJobsCli(["cancel", (params as { job_id: string }).job_id], ctx.cwd);
      return toolText(r.ok ? r.result : { error: r.error });
    },
  } as never);
}

export default function agentctlExtension(pi: ExtensionAPI) {
  registerAgentctlTools(pi);
  pi.registerCommand("agentctl", {
    description: "Dispatch to agentctl (ask | route | delegate | orchestrate | health | memory-test)",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "help";
      const rest = parts.slice(1).join(" ").trim();

      try {
        await ctx.waitForIdle();

        if (sub === "help" || !sub) {
          ctx.ui.notify(
            [
              "Pi = cockpit. agentctl = traffic controller. Codex/gpt-5.6-sol = orchestrator.",
              "Usage:",
              "  /agentctl health",
              "  /agentctl memory-test  (3 live Cursor calls, synthetic data only)",
              "  /agentctl briefing [--workspace <id>]  (local resume packet, no model call)",
              "  /agentctl memory-review [--workspace <id>]  (proposed queue; gateway if AGENTCTL_GATEWAY_URL)",
              "  /agentctl memory-write --workspace <id> --text \"…\" [--source pi:…]",
              "  /agentctl memory-accept --workspace <id> --id <uuid> --revision <n>",
              "  /agentctl ask --to <agent> <prompt>",
              "  /agentctl route <task>",
              "  /agentctl delegate <task>",
              "Team memory (optional): AGENTCTL_GATEWAY_URL + AGENTCTL_BRIEFING_WORKSPACE (JIT context on delegate/route/ask)",
              "  /agentctl delegate --briefing-workspace team-atlas \"…\"  (or rely on env default)",
              "  /agentctl orchestrate [--dry-plan|--run] [--orchestrator codex] [--orchestrator-model gpt-5.6-sol] <goal>",
              "Defaults: orchestrate is --dry-plan; --run plans with codex + gpt-5.6-sol then delegates steps.",
              "  /agentctl orchestrate --run --bg <goal>   start as a background job (returns a job id)",
              "  /agentctl job list | status|wait|result|events|cancel <job_id>",
            ].join("\n"),
            "info",
          );
          return;
        }

        if (sub === "briefing") {
          const workspace = (() => {
            const m = rest.match(/^--workspace\s+(\S+)/);
            return m?.[1] ?? "agentctl-pilot";
          })();
          const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
          let stdout: string;
          try {
            ({ stdout } = await execFileAsync(process.execPath, [
              cli, "memory", "briefing", "--workspace", workspace, "--provider", "pi",
            ], { cwd: ctx.cwd, timeout: 30_000, maxBuffer: 512 * 1024 }));
          } catch (error) {
            const output = (error as { stdout?: string }).stdout;
            if (!output?.trim()) throw error;
            stdout = output;
          }
          const body = JSON.parse(stdout.trim()) as {
            packet?: {
              checkpoint?: { goal?: string; state?: string; blockers?: string[]; nextAction?: string; revision?: number } | null;
              decisions?: Array<{ text?: string; source?: string; revision?: number }>;
              omittedDecisionRefs?: string[];
              unresolvedDecisionRefs?: string[];
            };
          };
          const p = body.packet;
          const cp = p?.checkpoint;
          const lines = [
            `Resume briefing · workspace ${workspace}`,
            cp ? `Goal: ${cp.goal}` : "No checkpoint saved yet.",
            cp ? `State: ${cp.state}` : "",
            cp?.blockers?.length ? `Blockers: ${cp.blockers.join("; ")}` : "",
            cp ? `Next: ${cp.nextAction} (rev ${cp.revision})` : "",
            p?.decisions?.length
              ? `Decisions:\n${p.decisions.map(d => `- ${d.text} (${d.source}, rev ${d.revision})`).join("\n")}`
              : "",
            p?.omittedDecisionRefs?.length ? `Omitted refs: ${p.omittedDecisionRefs.join(", ")}` : "",
            p?.unresolvedDecisionRefs?.length ? `Unresolved refs: ${p.unresolvedDecisionRefs.join(", ")}` : "",
          ].filter(Boolean);
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }

        if (sub === "memory-review") {
          const workspace = defaultMemoryWorkspace(parseFlag(rest, "--workspace"));
          const gateway = process.env.AGENTCTL_GATEWAY_URL?.trim();
          const stdout = gateway
            ? await execMemoryCli(["gateway", "review", "--workspace", workspace], ctx.cwd)
            : await execMemoryCli(["review", "--workspace", workspace], ctx.cwd);
          const body = JSON.parse(stdout) as { proposed?: Array<{ id: string; revision: number; text: string }> } | Array<{ id: string; revision: number; text: string }>;
          const items = Array.isArray(body) ? body : (body.proposed ?? []);
          ctx.ui.notify([
            `Review queue · ${workspace}${gateway ? " (gateway)" : ""}`,
            items.length
              ? items.map(m => `- [${m.id.slice(0, 8)}… rev ${m.revision}] ${m.text.slice(0, 120)}`).join("\n")
              : "(empty)",
          ].join("\n"), "info");
          return;
        }

        if (sub === "memory-write") {
          const workspace = parseFlag(rest, "--workspace") ?? resolveBriefingWorkspace();
          const text = parseQuoted(rest, "--text") ?? rest.replace(/^--text\s+\S+\s*/, "").trim();
          if (!workspace || !text) {
            ctx.ui.notify("Usage: /agentctl memory-write --workspace <id> --text \"…\" [--source pi:…]", "warning");
            return;
          }
          const source = parseQuoted(rest, "--source") ?? parseFlag(rest, "--source") ?? "pi:operator";
          const gateway = process.env.AGENTCTL_GATEWAY_URL?.trim();
          const argv = gateway
            ? ["gateway", "write", "--workspace", workspace, "--text", text, "--source", source, "--mode", "propose"]
            : ["write", "--workspace", workspace, "--text", text, "--source", source, "--mode", "propose"];
          const stdout = await execMemoryCli(argv, ctx.cwd);
          const out = JSON.parse(stdout) as { status?: string; memory?: { id: string; revision: number } };
          ctx.ui.notify(
            `Memory ${out.status ?? "ok"}${out.memory ? ` · id ${out.memory.id} rev ${out.memory.revision}` : ""}`,
            out.status === "rejected" ? "error" : "info",
          );
          return;
        }

        if (sub === "memory-accept") {
          const workspace = parseFlag(rest, "--workspace");
          const id = parseFlag(rest, "--id");
          const revision = parseFlag(rest, "--revision");
          if (!workspace || !id || !revision) {
            ctx.ui.notify("Usage: /agentctl memory-accept --workspace <id> --id <uuid> --revision <n>", "warning");
            return;
          }
          const gateway = process.env.AGENTCTL_GATEWAY_URL?.trim();
          const stdout = gateway
            ? await execMemoryCli([
              "gateway", "accept", "--workspace", workspace, "--id", id, "--revision", revision, "--human-approved",
            ], ctx.cwd)
            : await execMemoryCli([
              "accept", id, "--workspace", workspace, "--revision", revision,
            ], ctx.cwd);
          const out = JSON.parse(stdout) as { memory?: { id: string; revision: number; state: string } };
          ctx.ui.notify(
            `Accepted · ${out.memory?.id ?? id} rev ${out.memory?.revision ?? revision} (${out.memory?.state ?? "accepted"})`,
            "info",
          );
          return;
        }

        if (sub === "memory-test") {
          const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
          let stdout: string;
          try {
            ({ stdout } = await execFileAsync(process.execPath, [cli, "memory", "test"], {
              cwd: ctx.cwd, timeout: 300_000, maxBuffer: 2 * 1024 * 1024,
            }));
          } catch (error) {
            const output = (error as { stdout?: string }).stdout;
            if (!output?.trim()) throw error;
            stdout = output;
          }
          const result = JSON.parse(stdout) as { ok: boolean; directory: string; stages: Array<{stage:string;passed:boolean}>; error?:string };
          ctx.ui.notify([
            "Memory pilot: " + (result.ok ? "passed" : "failed/incomplete"),
            ...result.stages.map(s => `${s.passed ? "✓" : "✗"} ${s.stage}`),
            `Evidence: ${result.directory}/evidence/STATUS.md`, result.error ?? "",
          ].join("\n"), result.ok ? "info" : "error");
          return;
        }

        if (sub === "health") {
          const env = await runAgentctl(["agents", "health"], ctx.cwd);
          const agents = (env.result as { agents?: Array<{ name: string; available: boolean; detail: string }> })?.agents ?? [];
          const lines = agents.map((a) => `${a.available ? "✓" : "✗"} ${a.name} — ${a.detail}`);
          ctx.ui.notify(`agentctl fleet:\n${lines.join("\n")}${formatWarnings(env.warnings)}`, env.ok ? "info" : "warning");
          return;
        }

        if (sub === "ask") {
          if (!rest.trim()) {
            ctx.ui.notify("Usage: /agentctl ask --to <agent> <prompt>", "warning");
            return;
          }
          const env = await runAgentctl(["ask", ...applyWorkerBriefingArgv(parseWorkerArgs(rest))], ctx.cwd);
          const results = (env.result as { results?: Array<{ text?: string }> })?.results ?? [];
          const text = results[0]?.text ?? env.error ?? "no response";
          ctx.ui.notify(`${text}${formatWarnings(env.warnings)}`, env.ok ? "info" : "error");
          return;
        }

        if (sub === "route" || sub === "delegate") {
          if (!rest) {
            ctx.ui.notify(`Usage: /agentctl ${sub} <task>`, "warning");
            return;
          }
          const env = await runAgentctl([sub, ...applyWorkerBriefingArgv(parseWorkerArgs(rest))], ctx.cwd);
          const result = env.result as { route?: { agent?: string; model?: string }; ask?: { text?: string } } | undefined;
          const route = result?.route;
          const answer = result?.ask?.text;
          const header = route
            ? `→ ${route.agent ?? "none"}${route.model ? `:${route.model}` : ""}`
            : sub;
          ctx.ui.notify(
            `${header}\n\n${answer ?? env.error ?? "(no output)"}${formatWarnings(env.warnings)}`,
            env.ok ? "info" : "error",
          );
          return;
        }

        if (sub === "orchestrate") {
          const parsed = parseOrchestrateArgs(rest);
          if ("error" in parsed) {
            ctx.ui.notify(parsed.error, "warning");
            return;
          }

          const argv = [
            "orchestrate",
            "--orchestrator",
            parsed.orchestrator,
          ];
          if (parsed.orchestratorModel) argv.push("--orchestrator-model", parsed.orchestratorModel);
          if (parsed.dryPlan) argv.push("--dry-plan");
          if (parsed.approve) argv.push("--approve");
          if (parsed.resume) argv.push("--resume");
          if (parsed.budget) argv.push("--budget", parsed.budget);
          if (parsed.maxReplans) argv.push("--max-replans", parsed.maxReplans);
          argv.push(parsed.goal);

          if (parsed.background) {
            // Durable job: returns at once; Pi stays usable while it runs.
            const jobArgv = ["start", "orchestrate", "--orchestrator", parsed.orchestrator, "--caller", "pi"];
            if (parsed.orchestratorModel) jobArgv.push("--orchestrator-model", parsed.orchestratorModel);
            if (parsed.dryPlan) jobArgv.push("--dry-plan");
            if (parsed.approve) jobArgv.push("--approve");
            if (parsed.budget) jobArgv.push("--budget", parsed.budget);
            if (parsed.maxReplans) jobArgv.push("--max-replans", parsed.maxReplans);
            jobArgv.push(parsed.goal);
            const started = await runJobsCli(jobArgv, ctx.cwd);
            const id = (started.result as { id?: string } | undefined)?.id;
            ctx.ui.notify(
              started.ok && id
                ? `orchestration started as ${id}\nCheck: /agentctl job wait ${id}  ·  /agentctl job result ${id}  ·  /agentctl job cancel ${id}`
                : `could not start job: ${started.error ?? "unknown error"}`,
              started.ok ? "info" : "error",
            );
            return;
          }

          // Multi-step runs can exceed the default 10m shell timeout.
          const timeoutMs = parsed.dryPlan ? 600_000 : 1_800_000;
          const env = await runAgentctl(argv, ctx.cwd, timeoutMs);
          ctx.ui.notify(
            formatOrchestration(env, parsed.dryPlan, parsed.orchestrator, parsed.orchestratorModel),
            env.ok ? "info" : "error",
          );
          return;
        }

        if (sub === "job" || sub === "jobs") {
          const [action = "list", id, secs] = rest.trim().split(/\s+/).filter(Boolean);
          const allowed = ["list", "status", "wait", "result", "events", "cancel"];
          if (!allowed.includes(action) || (action !== "list" && !id)) {
            ctx.ui.notify("Usage: /agentctl job list | status|wait|result|events|cancel <job_id> [wait-seconds]", "warning");
            return;
          }
          const argv = action === "list" ? ["list"]
            : action === "wait" ? ["wait", id!, "--timeout", secs ?? "60"]
              : [action, id!];
          const env = await runJobsCli(argv, ctx.cwd, action === "wait" ? (Number(secs ?? 60) + 30) * 1000 : 120_000);
          ctx.ui.notify(
            env.ok ? JSON.stringify(env.result, null, 2) : `job ${action} failed: ${env.error ?? "unknown error"}`,
            env.ok ? "info" : "error",
          );
          return;
        }

        ctx.ui.notify(`Unknown /agentctl subcommand '${sub}'. Try /agentctl help`, "warning");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`agentctl failed: ${message}`, "error");
      }
    },
  });
}
