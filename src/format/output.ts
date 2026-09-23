/** Machine-readable vs human CLI output. */
export type OutputFormat = 'text' | 'json';

/** Strip ANSI escape codes for JSON warnings/errors. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Version of the JSON envelope contract. Bump on any breaking change to the
 * envelope or to a command's `result` shape, so calling agents can check it.
 */
export const JSON_SCHEMA_VERSION = 1;

export interface JsonEnvelope<T = unknown> {
  schemaVersion: number;
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
    schemaVersion: JSON_SCHEMA_VERSION,
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
