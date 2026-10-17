// server/config.mjs — bridge configuration (Hermes Voice v1.0).
// Precedence: env vars > ~/.hermes-voice/config.json > defaults.
// No secrets are ever stored here (spec §12.1 — Keychain only, and this build stores none).

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DATA_DIR = process.env.HV_DATA_DIR || join(homedir(), ".hermes-voice");
export const CONFIG_FILE = join(DATA_DIR, "config.json");
export const AUDIT_FILE = join(DATA_DIR, "audit.jsonl");
export const SESSIONS_DIR = join(DATA_DIR, "sessions");
export const LOG_DIR = join(DATA_DIR, "logs");
export const SCRATCH_DIR = join(DATA_DIR, "scratch");
export const TTS_CACHE_DIR = join(SCRATCH_DIR, "tts-cache");
export const OMNIROUTE_DB = process.env.HV_OMNI_DB || join(homedir(), ".9router/db/data.sqlite");

// Deterministic Python runtime resolution for Edge TTS (v1.0 spec §2.2):
//   1. process.env.HV_PYTHON
//   2. /Users/apple/.hermes/hermes-agent/venv/bin/python (primary verified macOS venv)
//   3. ~/.hermes/hermes-agent/venv/bin/python
//   4. ~/.hermes/installs/<version>/venv/bin/python
//   5. Global python3
export function resolvePython() {
  if (process.env.HV_PYTHON && existsSync(process.env.HV_PYTHON)) {
    return process.env.HV_PYTHON;
  }

  const primaryMacVenv = "/Users/apple/.hermes/hermes-agent/venv/bin/python";
  if (existsSync(primaryMacVenv)) {
    return primaryMacVenv;
  }

  const userHermesVenv = join(homedir(), ".hermes/hermes-agent/venv/bin/python");
  if (existsSync(userHermesVenv)) {
    return userHermesVenv;
  }

  const installsDir = join(homedir(), ".hermes/installs");
  if (existsSync(installsDir)) {
    try {
      const entries = readdirSync(installsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse();
      for (const dir of entries) {
        const candidate = join(installsDir, dir, "venv/bin/python");
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      /* ignore unreadable installs dir */
    }
  }

  return "python3";
}

/**
 * Deterministic Hermes CLI path hints for Apple Silicon / macOS environments.
 */
export const DEFAULT_HERMES_PATHS = [
  "/Users/apple/.hermes/hermes-agent/.hermes/bin",
  join(homedir(), ".hermes/hermes-agent/.hermes/bin"),
  join(homedir(), ".local/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

const defaults = {
  port: 20130,
  host: "127.0.0.1", // never 0.0.0.0 — this bridge must stay loopback-only
  allowedOrigins: [
    "http://localhost:20130",
    "http://127.0.0.1:20130",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
  ],
  maxConcurrentTasks: 10, // HARD RULE §2.2.8
  hermes: {
    // argvTemplate may name a launcher (e.g. node + fake-hermes.mjs) for testing
    command: ["hermes"],
    argvTemplate: ["chat", "-q", "{{utterance}}", "--format", "stream-json", "--session", "{{sessionId}}"],
    cwd: join(homedir(), ".hermes"),
    timeoutSec: 300,
    pathHint: DEFAULT_HERMES_PATHS,
  },
  omniroute: {
    baseURL: "http://127.0.0.1:20128",
    probeModel: "opc/beam-free",
    activeComboName: "KRITI / 9Router",
    sqlitePath: OMNIROUTE_DB,
  }, // strict read-only
  tts: {
    engine: "edge",
    voice: "hi-IN-MadhurNeural",
    englishVoice: "en-IN-NeerjaNeural",
    rate: "+0%",
    fallbackVoice: "Rishi",
    pythonPath: resolvePython(),
    cacheDir: TTS_CACHE_DIR,
  },
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
  let cfg = deepMerge({}, defaults);
  if (existsSync(CONFIG_FILE)) {
    try {
      cfg = deepMerge(defaults, JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
    } catch (e) {
      console.error(`[config] ignoring unreadable ${CONFIG_FILE}: ${e.message}`);
    }
  }
  if (process.env.HV_PORT) cfg.port = Number(process.env.HV_PORT);
  if (process.env.HV_HERMES_CMD) cfg.hermes.command = process.env.HV_HERMES_CMD.split(" ").filter(Boolean);
  if (process.env.HV_HERMES_CWD) cfg.hermes.cwd = process.env.HV_HERMES_CWD;
  if (process.env.HV_OMNI_BASE) cfg.omniroute.baseURL = process.env.HV_OMNI_BASE;
  if (process.env.HV_TTS_ENGINE) cfg.tts.engine = process.env.HV_TTS_ENGINE;
  if (process.env.HV_TTS_VOICE) cfg.tts.voice = process.env.HV_TTS_VOICE;
  cfg.tts.pythonPath = resolvePython();
  cfg.tts.cacheDir = TTS_CACHE_DIR;
  return cfg;
}

export function saveConfig(patch) {
  ensureDirs();
  const next = deepMerge(loadConfig(), patch);
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

export function ensureDirs() {
  for (const d of [DATA_DIR, SESSIONS_DIR, LOG_DIR, SCRATCH_DIR, TTS_CACHE_DIR]) {
    mkdirSync(d, { recursive: true });
  }
}
