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

const ALLOW = /\b(allow|yes|yep|haan|haa|ha|kar\s*do|kar\s*de|permission\s*di|proceed|theek\s*hai|theek|ok|okay|approve|allowed|chalo|chalega)\b/i;
const DENY = /\b(deny|no|nope|nahi|na|mat\s*kar|mat|ruk\s*jao|ruko|ruk|cancel|reject|stop|abort)\b/i;

/** Voice decision mapping. Ambiguous input returns null — never guess. */
export function mapVoiceDecision(text) {
  const s = String(text ?? "").toLowerCase().trim();
  if (!s) return null;
  const isAllow = ALLOW.test(s);
  const isDeny = DENY.test(s);
  if (isAllow && isDeny) return null; // ambiguous
  if (isAllow) return "allow";
  if (isDeny) return "deny";
  return null;
}

const VERBOSE_RE = /\b(time\s*to\s*time|update\s*do|update\s*dete\s*raho|har\s*step|kitna\s*chal\s*raha\s*hai\s*bata|sab\s*batao|progress\s*update\s*on)\b/i;
const DIRECT_RE = /\b(beech\s*me\s*mat\s*bol|chup\s*raho|chup\s*reh|sirf\s*last\s*me|direct\s*answer|last\s*me\s*bolna|update\s*mat\s*do|direct\s*mode)\b/i;
const ON_DEMAND_RE = /\b(silent|poochu\s*tab|poochne\s*pe|apne\s*aap\s*mat\s*bolna|on\s*demand)\b/i;
const STATUS_RE = /\b(ban\s*gaya\s*kya|ban\s*gaya|ho\s*gaya\s*kya|ho\s*gaya|kitna\s*kaam\s*hua|kya\s*status\s*hai|kya\s*chal\s*raha\s*hai|progress\s*batao|kuch\s*bana|kahan\s*tak\s*pahuncha)\b/i;

/** Detects if user utterance is a command to change narration style or check progress */
export function detectConversationalIntent(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  
  if (VERBOSE_RE.test(s)) {
    return { type: "modeChange", mode: "verbose", reply: "Theek hai, time-to-time progress updates deta rahunga." };
  }
  if (DIRECT_RE.test(s)) {
    return { type: "modeChange", mode: "direct", reply: "Samajh gaya. Beech me update nahi bolunga, seedha final answer bataunga." };
  }
  if (ON_DEMAND_RE.test(s)) {
    return { type: "modeChange", mode: "on_demand", reply: "Done, silent mode activate ho gaya. Jab aap poochoge 'ban gaya kya', tabhi bolunga." };
  }
  if (STATUS_RE.test(s)) {
    return { type: "statusCheck" };
  }
  return null;
}
