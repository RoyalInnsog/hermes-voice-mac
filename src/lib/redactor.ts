// Section 12.2 — Redaction filter. Applied to every log line, audit entry and
// anything rendered in the UI that may contain credentials.

const KEYED_PATTERNS: RegExp[] = [
  /\b(api[_-]?key|apikey|secret|password|passwd|token|bearer|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*("?)([^\s"',}]+)\2/gi,
];

const LITERAL_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g, // OpenAI style
  /\bAIza[0-9A-Za-z_-]{10,}\b/g, // Google API keys
  /\bghp_[A-Za-z0-9]{10,}\b/g, // GitHub PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWT
];

// Heuristic: long high-entropy alphanumeric runs (>= 24 chars, mixed case/digits).
const HEURISTIC = /\b(?=[A-Za-z0-9_-]{24,})(?=[^\s]*[A-Za-z])(?=[^\s]*\d)[A-Za-z0-9_-]{24,}\b/g;

export const REDACTED = "[REDACTED]";

export function redact(input: string): string {
  if (!input) return input;
  let out = input;
  for (const p of KEYED_PATTERNS) {
    out = out.replace(p, (_m, key: string, q: string) => `${key}=${q}${REDACTED}${q}`);
  }
  for (const p of LITERAL_PATTERNS) out = out.replace(p, REDACTED);
  out = out.replace(HEURISTIC, (m) => (m === REDACTED ? m : REDACTED));
  return out;
}

export function redactArgs(args: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    const sensitiveKey = /key|secret|token|password|credential|auth/i.test(k);
    out[k] = sensitiveKey ? REDACTED : redact(v);
  }
  return out;
}

export function formatArgs(args: Record<string, string>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${v}`)
    .join("  ");
}
