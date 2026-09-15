import type { AgentReport, AgentwatchOutput } from "../types.js";
import { sanitizeTerminal } from "./sanitize.js";

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
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
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}

function stateLabel(agent: AgentReport): string {
  return agent.state === "unknown" ? "unknown" : `${agent.state}/${agent.activity === "active" ? "signal" : agent.activity}`;
}

export function renderTable(output: AgentwatchOutput): string {
  const rows = output.agents.map((agent) => ({
    agent: sanitizeTerminal(agent.label),
    state: stateLabel(agent),
    external: `${formatBytes(agent.bytes_out_external)} out / ${formatBytes(agent.bytes_in_external)} in`,
    loopback: `${formatBytes(agent.bytes_out_loopback)} out / ${formatBytes(agent.bytes_in_loopback)} in`,
    processes: String(agent.processes.length)
  }));
  const headers = ["AGENT FAMILY", "STATE", "EXTERNAL", "LOOPBACK", "PROCS"];
  const values = rows.map((row) => [
    row.agent,
    row.state,
    row.external,
    row.loopback,
    row.processes
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...values.map((row) => row[index]!.length))
  );

  const line = (row: string[]): string =>
    row.map((value, index) => value.padEnd(widths[index]!)).join("  ").trimEnd();
  const outputLines = [line(headers), line(widths.map((width) => "-".repeat(width)))];
  outputLines.push(...values.map(line));
  outputLines.push(`observed: ${output.generated_at}; bytes are family totals, not job progress`);
  outputLines.push(
    `sampling: ${output.sampling} (${output.sample_window_ms} ms), collectors: ps=${output.collectors.ps} nettop=${output.collectors.nettop} probes=${output.collectors.probes}`
  );
  outputLines.push(...output.warnings.map((warning) => `warning: ${sanitizeTerminal(warning)}`));
  return `${outputLines.join("\n")}\n`;
}

export { formatBytes };
