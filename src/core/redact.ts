/**
 * Strip credential-shaped strings before anything is written to a trace, a raw
 * artifact, or adapter output. Defense-in-depth: agentctl never intentionally
 * handles credentials (children inherit their own keychain/OAuth), but model
 * output and JSON echo modes can surface them, so we scrub on every write.
 */
const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, // bearer tokens
  /AIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /xox[baprs]-[A-Za-z0-9-]{8,}/g, // Slack tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
];

const REDACTION = '[REDACTED]';

export function redact(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, REDACTION);
  return out;
}
