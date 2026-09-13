// Minimal ANSI colorizer. Colors are emitted only to a TTY (or when
// FORCE_COLOR is set), and never when NO_COLOR is set — so piped/redirected
// output and tests stay plain.
const FORCE = !!process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0';
const enabled = FORCE || (process.stdout.isTTY === true && !process.env.NO_COLOR);

function wrap(open: number): (s: string) => string {
  return (s) => (enabled ? `\x1b[${open}m${s}\x1b[0m` : s);
}

export const color = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
  gray: wrap(90),
};

const AGENT_COLOR: Record<string, (s: string) => string> = {
  claude: color.yellow,
  codex: color.cyan,
  hermes: color.magenta,
  comet: color.green,
  dry_run: color.gray,
};

/** A stable color per agent, so output is visually distinguishable. */
export function agentColor(name: string): (s: string) => string {
  return AGENT_COLOR[name] ?? color.bold;
}

export const colorEnabled = enabled;
