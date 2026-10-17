// server/config.mjs — Hermes Voice v1.0 production configuration & runtime discovery.
// Precedence: env vars > ~/.hermes-voice/config.json > defaults.
// No secrets are ever stored here (spec §12.1 — Keychain only, and this build stores none).

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = resolve(__dirname, "..");
export const DIST_DIR = process.env.HV_DIST_DIR || join(PROJECT_ROOT, "dist");
export const DATA_DIR = process.env.HV_DATA_DIR || join(homedir(), ".hermes-voice");
export const CONFIG_FILE = join(DATA_DIR, "config.json");
export const AUDIT_FILE = join(DATA_DIR, "audit.jsonl");
export const SESSIONS_DIR = join(DATA_DIR, "sessions");
export const LOG_DIR = join(DATA_DIR, "logs");
export const SCRATCH_DIR = join(DATA_DIR, "scratch");
export const TTS_CACHE_DIR = join(SCRATCH_DIR, "tts-cache");

export const OMNIROUTE_DB_PATH =
  process.env.HV_OMNI_DB ||
  (existsSync("/Users/apple/.9router/db/data.sqlite")
    ? "/Users/apple/.9router/db/data.sqlite"
    : join(homedir(), ".9router", "db", "data.sqlite"));

/**
 * Resolve the working Python runtime with edge-tts using deterministic fallbacks:
 *   1. process.env.HV_PYTHON
 *   2. /Users/apple/.hermes/hermes-agent/venv/bin/python (primary verified macOS venv)
 *   3. ~/.hermes/hermes-agent/venv/bin/python
 *   4. ~/.hermes/installs/*\/venv/bin/python
 *   5. Global python3
 */
export function resolvePython() {
  if (process.env.HV_PYTHON && existsSync(process.env.HV_PYTHON)) {
    return process.env.HV_PYTHON;
  }

  const primaryMacVenv = "/Users/apple/.hermes/hermes-agent/venv/bin/python";
  if (existsSync(primaryMacVenv)) return primaryMacVenv;

  const homeVenv = join(homedir(), ".hermes", "hermes-agent", "venv", "bin", "python");
  if (existsSync(homeVenv)) return homeVenv;

  const installsRoots = [
    "/Users/apple/.hermes/installs",
    join(homedir(), ".hermes", "installs"),
  ];
  for (const root of installsRoots) {
    if (!existsSync(root)) continue;
    try {
      const dirs = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse();
      for (const d of dirs) {
        const candidate = join(root, d, "venv", "bin", "python");
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      /* ignore unreadable install dir */
    }
  }

  for (const sysPy of ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]) {
    if (existsSync(sysPy)) return sysPy;
  }

  return "python3";
}

export const HERMES_PATH_HINTS = [
  "/Users/apple/.hermes/hermes-agent/.hermes/bin",
  join(homedir(), ".hermes", "hermes-agent", ".hermes", "bin"),
  "/Users/apple/.local/bin",
  join(homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

function defaultHermesCommand() {
  const candidates = [
    "/Users/apple/.hermes/hermes-agent/.hermes/bin/hermes",
    join(homedir(), ".hermes", "hermes-agent", ".hermes", "bin", "hermes"),
    "/Users/apple/.local/bin/hermes",
    join(homedir(), ".local", "bin", "hermes"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return [c];
  }
  return ["hermes"];
}

const defaults = {
  port: 20130,
  host: "127.0.0.1", // loopback-only by default
  allowedOrigins: [
    "http://localhost:20130",
    "http://127.0.0.1:20130",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
  ],
  maxConcurrentTasks: 10, // HARD RULE §1.6 / §2.2.8
  hermes: {
    command: defaultHermesCommand(),
    argvTemplate: ["chat", "-q", "{{utterance}}", "--format", "stream-json"],
    cwd: existsSync("/Users/apple/.hermes") ? "/Users/apple/.hermes" : join(homedir(), ".hermes"),
    timeoutSec: 300,
    pathHint: HERMES_PATH_HINTS,
  },
  omniroute: {
    baseURL: "http://127.0.0.1:20128",
    probeModel: "opc/beam-free",
    activeCombo: "KRITI / 9Router",
    sqlitePath: OMNIROUTE_DB_PATH,
  },
  tts: {
    engine: "edge",
    voice: "hi-IN-MadhurNeural",
    englishVoice: "en-IN-NeerjaNeural",
    usVoice: "en-US-ChristopherNeural",
    rate: "+0%",
    fallbackVoice: "Rishi",
    geminiOptIn: false, // ~10 req/day free tier cap — strictly disabled unless manually opted in
  },
  permissions: {
    timeoutSec: 60,
    autoApproveLowRisk: false,
  },
  logging: {
    level: "info",
    redact: true,
  },
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
      cfg = deepMerge(cfg, JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
    } catch (e) {
      console.error(`[config] ignoring unreadable ${CONFIG_FILE}: ${e.message}`);
    }
  }
  if (process.env.HV_PORT) cfg.port = Number(process.env.HV_PORT);
  if (process.env.HV_HOST) cfg.host = process.env.HV_HOST;
  if (process.env.HV_HERMES_CMD) cfg.hermes.command = process.env.HV_HERMES_CMD.trim().split(/\s+/);
  if (process.env.HV_HERMES_ARGS) cfg.hermes.argvTemplate = process.env.HV_HERMES_ARGS.trim().split(/\s+/);
  if (process.env.HV_HERMES_CWD) cfg.hermes.cwd = process.env.HV_HERMES_CWD;
  if (process.env.HV_OMNI_BASE) cfg.omniroute.baseURL = process.env.HV_OMNI_BASE;
  if (process.env.HV_OMNI_DB) cfg.omniroute.sqlitePath = process.env.HV_OMNI_DB;
  if (process.env.HV_TTS_ENGINE) cfg.tts.engine = process.env.HV_TTS_ENGINE;
  if (process.env.HV_TTS_VOICE) cfg.tts.voice = process.env.HV_TTS_VOICE;
  return cfg;
}

export function saveConfig(patch) {
  mkdirSync(DATA_DIR, { recursive: true });
  const next = deepMerge(loadConfig(), patch);
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

export function ensureDirs() {
  for (const d of [DATA_DIR, SESSIONS_DIR, LOG_DIR, SCRATCH_DIR, TTS_CACHE_DIR]) {
    mkdirSync(d, { recursive: true });
  }
}
