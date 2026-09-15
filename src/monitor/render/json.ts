import type { AgentwatchOutput } from "../types.js";

export function renderJson(output: AgentwatchOutput): string {
  return `${JSON.stringify(output, null, 2)}\n`;
}

