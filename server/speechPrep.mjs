// server/speechPrep.mjs — make agent output speakable (spec §6.8 text preprocessing).
// Mirrors src/lib/speech.ts so both sides produce the same spoken text.

export function speechify(input) {
  let s = String(input ?? "");
  s = s.replace(/```[\s\S]*?```/g, " code block, detail overlay me hai, ");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " image ");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/https?:\/\/\S+/g, " link ");
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, "");
  s = s.replace(/[*_~>#|]/g, " ");
  s = s.replace(/\s{2,}/g, " ");
  return s.trim();
}

export function summarizeForSpeech(input, maxChars = 320) {
  const clean = speechify(input);
  if (clean.length <= maxChars) return clean;
  const sentences = clean.split(/(?<=[.!?])\s+/);
  let out = "";
  for (const sentence of sentences.slice(0, 3)) {
    if ((out + sentence).length > maxChars) break;
    out += (out ? " " : "") + sentence;
  }
  if (!out) out = clean.slice(0, maxChars);
  return `${out} Poori report overlay me hai.`;
}

const DENY = /\b(deny|no|nope|nahi|na|mat|mat\s+kar|ruk|ruko|nahi\s+ruko|cancel|reject|stop|rehne\s+do)\b/i;
const ALLOW =
  /\b(allow|yes|yep|haan|haa|ha|kar\s*do|kar\s*de|theek\s*hai|theek|permission\s*di|proceed|ok|okay|approve|allowed|chalo)\b/i;

/** Voice decision mapping. Ambiguous input returns null — never guess. */
export function mapVoiceDecision(text) {
  const s = String(text ?? "").toLowerCase().trim();
  if (!s) return null;
  if (DENY.test(s)) return "deny";
  if (ALLOW.test(s)) return "allow";
  return null;
}
