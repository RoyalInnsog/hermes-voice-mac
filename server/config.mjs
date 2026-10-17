// server/config.mjs — bridge configuration.
// Precedence: env vars > ~/.hermes-voice/config.json > defaults.
// No secrets are ever stored here (spec §12.1 — Keychain only, and this build stores none).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DATA_DIR = process.env.HV_DATA_DIR || join(homedir(), ".hermes-voice");
export const CONFIG_FILE = join(DATA_DIR, "config.json");
export const AUDIT_FILE = join(DATA_DIR, "audit.jsonl");
export const SESSIONS_DIR = join(DATA_DIR, "sessions");
export const LOG_DIR = join(DATA_DIR, "logs");
export const SCRATCH_DIR = join(DATA_DIR, "scratch");

const defaults = {
  port: 20130,
  host: "127.0.0.1", // never 0.0.0.0 — this bridge must stay loopback-only
  allowedOrigins: ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173"],
  maxConcurrentTasks: 10, // HARD RULE §2.2.8
  hermes: {
    // argvTemplate may name a launcher (e.g. node + fake-hermes.mjs) for testing
    command: ["hermes"],
    argvTemplate: ["chat", "-q", "{{utterance}}", "--session", "{{sessionId}}"], // TODO-VERIFY
    cwd: join(homedir(), ".hermes"),
    timeoutSec: 300,
    pathHint: ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local/bin")],
  },
  omniroute: { baseURL: "http://127.0.0.1:20128", probeModel: "opc/beam-free" }, // read-only
  tts: { engine: "edge", voice: "hi-IN-MadhurNeural", rate: "+0%", fallbackVoice: "Rishi" },
  permissions: { timeoutSec: 60, autoApproveLowRisk: false },
  logging: { level: "info", redact: true },
};

function deepMerge(base, over) {
  if (!over || typeof over !== "object") return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(base?.[k], v) : v;
  }
  return out;
}

export function loadConfig() {
  let cfg = defaults;
  if (existsSync(CONFIG_FILE)) {
    try {
      cfg = deepMerge(defaults, JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
    } catch (e) {
      console.error(`[config] ignoring unreadable ${CONFIG_FILE}: ${e.message}`);
    }
  }
  if (process.env.HV_PORT) cfg.port = Number(process.env.HV_PORT);
  if (process.env.HV_HERMES_CMD) cfg.hermes.command = process.env.HV_HERMES_CMD.split(" ");
  if (process.env.HV_HERMES_CWD) cfg.hermes.cwd = process.env.HV_HERMES_CWD;
  if (process.env.HV_OMNI_BASE) cfg.omniroute.baseURL = process.env.HV_OMNI_BASE;
  if (process.env.HV_TTS_ENGINE) cfg.tts.engine = process.env.HV_TTS_ENGINE;
  return cfg;
}

export function saveConfig(patch) {
  mkdirSync(DATA_DIR, { recursive: true });
  const next = deepMerge(loadConfig(), patch);
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

export function ensureDirs() {
  for (const d of [DATA_DIR, SESSIONS_DIR, LOG_DIR, SCRATCH_DIR]) mkdirSync(d, { recursive: true });
}
