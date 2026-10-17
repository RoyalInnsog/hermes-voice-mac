// server/speechPrep.mjs — make agent output speakable & map spoken decisions (Spec §2.4).

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

// Denials checked first so phrases like "nahi kar do" / "nahi ruko" never falsely match allow.
const DENY = /\b(nahi\s*ruko|nahi|na\b|no\b|nope|deny|denied|ruk\s*jao|ruko|ruk\b|cancel|mat\s*karo|mat\s*kar|mat\b|stop|reject)\b/i;
const ALLOW = /\b(permission\s*di|haan\s*kar\s*do|kar\s*de|kar\s*do|theek\s*hai|theek|haan|haa|ha\b|yes\b|yep|allow|allowed|proceed|ok\b|okay|approve|approved)\b/i;

/**
 * Voice decision mapping (Spec §2.4):
 *   Affirmations: ["haan", "ha", "yes", "allow", "proceed", "kar de", "kar do", "permission di", "theek hai"] -> "allow"
 *   Denials:      ["nahi", "no", "deny", "ruk", "ruko", "nahi ruko", "cancel", "mat kar"] -> "deny"
 *   Ambiguous input returns null — never guess.
 */
export function mapVoiceDecision(text) {
  const s = String(text ?? "").toLowerCase().trim();
  if (!s) return null;
  if (DENY.test(s)) return "deny";
  if (ALLOW.test(s)) return "allow";
  return null;
}
