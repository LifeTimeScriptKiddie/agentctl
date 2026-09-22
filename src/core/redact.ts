/**
 * Strip credential-shaped strings before anything is written to a trace, a raw
 * artifact, or adapter output. Defense-in-depth: agentctl never intentionally
 * handles credentials (children inherit their own keychain/OAuth), but model
 * output and JSON echo modes can surface them, so we scrub on every write.
 *
 * Patterns also run over JSON.stringify output, so none may consume `"` or `\`
 * (that would unbalance an escaped quote and corrupt the line).
 */
const REDACTION = '[REDACTED]';

const PATTERNS: Array<[RegExp, string]> = [
  // PEM private keys, whole block (literal or JSON-escaped newlines).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[^"]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, REDACTION],
  // URL credentials: scheme://user:pass@host → scheme://[REDACTED]@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'\\]+:[^\s/@"'\\]+@/gi, `$1${REDACTION}@`],
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, REDACTION], // Anthropic
  [/sk-[A-Za-z0-9_-]{16,}/g, REDACTION], // OpenAI-style
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, REDACTION], // bearer tokens
  [/AIza[0-9A-Za-z_-]{20,}/g, REDACTION], // Google API keys
  [/github_pat_[A-Za-z0-9_]{20,}/g, REDACTION], // GitHub fine-grained PATs
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, REDACTION], // GitHub tokens
  [/glpat-[A-Za-z0-9_-]{20,}/g, REDACTION], // GitLab PATs
  [/xox[baprs]-[A-Za-z0-9-]{8,}/g, REDACTION], // Slack tokens
  [/AKIA[0-9A-Z]{16}/g, REDACTION], // AWS access key id
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTION], // JWT
  // password=/token=/secret=/api_key= query or kv values (also access_token=…).
  [/(?<![A-Za-z0-9])(password|token|secret|api_key)=[^\s&"'\\,;]+/gi, `$1=${REDACTION}`],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** `redact` every string inside a JSON-shaped value (keys untouched). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map(v => redactDeep(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]),
    ) as T;
  }
  return value;
}
