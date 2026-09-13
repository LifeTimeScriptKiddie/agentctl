import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

/** Packaged agentctl defaults for plan/verify/synth. */
const DEFAULT_ORCHESTRATOR = "codex";
const DEFAULT_ORCHESTRATOR_MODEL = "gpt-6-astra";

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
    ({ stdout } = await execFileAsync(process.execPath, [fileURLToPath(new URL("../cli.js", import.meta.url)), ...args, "--format", "json"], {
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

function formatWarnings(warnings: string[]): string {
  return warnings.length ? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
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
        "Usage: /agentctl orchestrate [--dry-plan|--run] [--orchestrator codex] [--orchestrator-model gpt-6-astra] <goal>",
    };
  }

  // Default stays dry-plan (safe preview). --run executes. If both, --run wins.
  if (!dryPlan && !run) dryPlan = true;
  if (run) dryPlan = false;

  return { dryPlan, run, approve, resume, orchestrator, orchestratorModel, budget, maxReplans, goal };
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

export default function agentctlExtension(pi: ExtensionAPI) {
  pi.registerCommand("agentctl", {
    description: "Dispatch to agentctl (ask | route | delegate | orchestrate | health)",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "help";
      const rest = parts.slice(1).join(" ").trim();

      try {
        await ctx.waitForIdle();

        if (sub === "help" || !sub) {
          ctx.ui.notify(
            [
              "Pi = cockpit. agentctl = traffic controller. Codex/gpt-6-astra = orchestrator.",
              "Usage:",
              "  /agentctl health",
              "  /agentctl ask --to <agent> <prompt>",
              "  /agentctl route <task>",
              "  /agentctl delegate <task>",
              "  /agentctl orchestrate [--dry-plan|--run] [--orchestrator codex] [--orchestrator-model gpt-6-astra] <goal>",
              "Defaults: orchestrate is --dry-plan; --run plans with codex + gpt-6-astra then delegates steps.",
            ].join("\n"),
            "info",
          );
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
          const match = rest.match(/^--to\s+(\S+)\s+([\s\S]*)$/);
          if (!match) {
            ctx.ui.notify("Usage: /agentctl ask --to <agent> <prompt>", "warning");
            return;
          }
          const [, agent, prompt] = match;
          const env = await runAgentctl(["ask", "--to", agent!, prompt!], ctx.cwd);
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
          const env = await runAgentctl([sub, rest], ctx.cwd);
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

          // Multi-step runs can exceed the default 10m shell timeout.
          const timeoutMs = parsed.dryPlan ? 600_000 : 1_800_000;
          const env = await runAgentctl(argv, ctx.cwd, timeoutMs);
          ctx.ui.notify(
            formatOrchestration(env, parsed.dryPlan, parsed.orchestrator, parsed.orchestratorModel),
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
