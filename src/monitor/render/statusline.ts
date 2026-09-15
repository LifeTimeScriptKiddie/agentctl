import type { AgentReport, AgentwatchOutput } from "../types.js";
import { sanitizeTerminal } from "./sanitize.js";

function shortName(agent: AgentReport): string {
  const names: Record<string, string> = {
    "claude-code": "claude",
    "codex-cli": "codex",
    "cursor-agent": "cursor",
    comet: "comet",
    ollama: "ollama",
    lmstudio: "lmstudio"
  };
  return sanitizeTerminal(names[agent.id] ?? agent.id);
}

function marker(state: AgentReport["state"]): string {
  switch (state) {
    case "confirmed":
      return "●";
    case "suspected":
      return "◐";
    case "unknown":
      return "?";
    case "absent":
      return "○";
  }
}

function compactBytes(value: number): string {
  if (value < 1024) {
    return `${value}B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = "B";
  for (const candidate of units) {
    amount /= 1024;
    unit = candidate;
    if (amount < 1024 || candidate === units.at(-1)) {
      break;
    }
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)}${unit}`;
}

export function renderStatusline(output: AgentwatchOutput): string {
  if (output.agents.length === 0) {
    return "no agents\n";
  }

  const parts = output.agents.map((agent) => {
    const externalOut = agent.bytes_out_external;
    const localBytes =
      agent.bytes_out_loopback + agent.bytes_in_loopback;
    let detail = "";
    if (externalOut > 0) {
      detail = `${compactBytes(externalOut)}↑`;
    } else if (localBytes > 0 || (agent.kind === "local" && agent.models.length > 0)) {
      detail = "local";
    }
    return `${shortName(agent)} ${marker(agent.state)}${detail}`;
  });
  return `families: ${parts.join(" · ")}\n`;
}

export { compactBytes };
