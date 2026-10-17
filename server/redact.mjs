// server/redact.mjs — same redaction rules as src/lib/redactor.ts.
// Applied at the sink: every log line, audit row and error payload.

export const REDACTED = "[REDACTED]";

const KEYED =
  /\b(api[_-]?key|apikey|secret|password|passwd|token|bearer|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*("?)([^\s"',}]+)\2/gi;

const LITERAL = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bAIza[0-9A-Za-z_-]{10,}\b/g,
  /\bghp_[A-Za-z0-9]{10,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
];

const HEURISTIC = /\b(?=[A-Za-z0-9_-]{24,})(?=[^\s]*[A-Za-z])(?=[^\s]*\d)[A-Za-z0-9_-]{24,}\b/g;

export function redact(input) {
  if (typeof input !== "string" || !input) return input;
  let out = input;
  out = out.replace(KEYED, (_m, key, q) => `${key}=${q}${REDACTED}${q}`);
  for (const p of LITERAL) out = out.replace(p, REDACTED);
  out = out.replace(HEURISTIC, REDACTED);
  return out;
}

export function redactArgs(args = {}) {
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    const sensitive = /key|secret|token|password|credential|auth/i.test(k);
    out[k] = sensitive ? REDACTED : redact(String(v ?? ""));
  }
  return out;
}

export function formatArgs(args = {}) {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${v}`)
    .join("  ");
}
