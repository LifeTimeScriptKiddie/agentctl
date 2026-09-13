/** Machine-readable vs human CLI output. */
export type OutputFormat = 'text' | 'json';

/** Strip ANSI escape codes for JSON warnings/errors. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

export interface JsonEnvelope<T = unknown> {
  ok: boolean;
  exitCode: number;
  command: string;
  warnings: string[];
  result?: T;
  error?: string;
}

export function buildJsonEnvelope<T>(
  command: string,
  exitCode: number,
  warnings: string[],
  result?: T,
  error?: string,
): JsonEnvelope<T> {
  const envelope: JsonEnvelope<T> = {
    ok: exitCode === 0,
    exitCode,
    command,
    warnings,
  };
  if (result !== undefined) envelope.result = result;
  if (error) envelope.error = error;
  return envelope;
}

export function emitJson<T>(io: { out: (s: string) => void }, envelope: JsonEnvelope<T>): void {
  io.out(JSON.stringify(envelope));
}
