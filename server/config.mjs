// server/config.mjs — Hermes Voice v1.0 production configuration & path discovery.
// Precedence: env vars > ~/.hermes-voice/config.json > deterministic local defaults.
// Strictly ₹0 / free routes only. No secrets stored on disk.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HOME = homedir();

export const DATA_DIR = process.env.HV_DATA_DIR || join(HOME, ".hermes-voice");
export const CONFIG_FILE = join(DATA_DIR, "config.json");
export const AUDIT_FILE = join(DATA_DIR, "audit.jsonl");
export const SESSIONS_DIR = join(DATA_DIR, "sessions");
export const LOG_DIR = join(DATA_DIR, "logs");
export const SCRATCH_DIR = join(DATA_DIR, "scratch");
export const TTS_CACHE_DIR = join(SCRATCH_DIR, "tts-cache");

/**
 * Deterministic Python runtime resolution (Spec §2.2):
 *   1. process.env.HV_PYTHON
 *   2. /Users/apple/.hermes/hermes-agent/venv/bin/python (primary verified python on Mac)
 *   3. ~/.hermes/hermes-agent/venv/bin/python
 *   4. ~/.hermes/installs/<any>/venv/bin/python
 *   5. Global python3
 */
export function resolvePythonRuntime() {
  const candidates = [];
  if (process.env.HV_PYTHON) {
    candidates.push({ path: process.env.HV_PYTHON, source: "env:HV_PYTHON" });
  }
  candidates.push({
    path: "/Users/apple/.hermes/hermes-agent/venv/bin/python",
    source: "verified-mac-venv",
  });
  const userHermesVenv = join(HOME, ".hermes", "hermes-agent", "venv", "bin", "python");
  if (userHermesVenv !== "/Users/apple/.hermes/hermes-agent/venv/bin/python") {
    candidates.push({ path: userHermesVenv, source: "home-hermes-venv" });
  }

  const installsDir = join(HOME, ".hermes", "installs");
  if (existsSync(installsDir)) {
    try {
      for (const entry of readdirSync(installsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          candidates.push({
            path: join(installsDir, entry.name, "venv", "bin", "python"),
            source: `installs/${entry.name}`,
          });
        }
      }
    } catch {
      /* ignore unreadable installs dir */
    }
  }

  for (const c of candidates) {
    if (c.path && existsSync(c.path)) {
      return { bin: c.path, source: c.source, verifiedVenv: true, candidates: candidates.map((x) => x.path) };
    }
  }

  return { bin: "python3", source: "system-path-fallback", verifiedVenv: false, candidates: candidates.map((x) => x.path) };
}

/**
 * Deterministic Hermes CLI path discovery (Spec §1.2):
 *   1. /Users/apple/.hermes/hermes-agent/.hermes/bin/hermes
 *   2. ~/.hermes/hermes-agent/.hermes/bin/hermes
 *   3. ~/.local/bin/hermes
 *   4. /opt/homebrew/bin/hermes
 *   5. /usr/local/bin/hermes
 */
export const HERMES_SEARCH_PATHS = [
  "/Users/apple/.hermes/hermes-agent/.hermes/bin",
  join(HOME, ".hermes", "hermes-agent", ".hermes", "bin"),
  join(HOME, ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

export function resolveDefaultHermesCommand() {
  if (process.env.HV_HERMES_CMD) {
    return process.env.HV_HERMES_CMD.trim().split(/\s+/);
  }
  const explicitPaths = [
    "/Users/apple/.hermes/hermes-agent/.hermes/bin/hermes",
    join(HOME, ".hermes", "hermes-agent", ".hermes", "bin", "hermes"),
    join(HOME, ".local", "bin", "hermes"),
    "/opt/homebrew/bin/hermes",
    "/usr/local/bin/hermes",
  ];
  for (const p of explicitPaths) {
    if (existsSync(p)) return [p];
  }
  return ["hermes"];
}

ensureDirs();
const pyInfo = resolvePythonRuntime();

const defaults = {
  port: 20130,
  host: "127.0.0.1", // loopback-only security boundary
  allowedOrigins: [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "http://localhost:20130",
    "http://127.0.0.1:20130",
  ],
  maxConcurrentTasks: 10, // HARD RULE §1.6
  hermes: {
    command: resolveDefaultHermesCommand(),
    argvTemplate: ["chat", "-q", "{{utterance}}", "--format", "stream-json"],
    cwd: existsSync("/Users/apple/.hermes") ? "/Users/apple/.hermes" : join(HOME, ".hermes"),
    timeoutSec: 300,
    pathHint: HERMES_SEARCH_PATHS,
  },
  python: {
    bin: pyInfo.bin,
    source: pyInfo.source,
    verifiedVenv: pyInfo.verifiedVenv,
  },
  omniroute: {
    baseURL: "http://127.0.0.1:20128", // STRICT READ-ONLY
    probeModel: "opc/beam-free",
    activeComboHint: "KRITI",
    sqlitePath: existsSync("/Users/apple/.9router/db/data.sqlite")
      ? "/Users/apple/.9router/db/data.sqlite"
      : join(HOME, ".9router", "db", "data.sqlite"),
  },
  tts: {
    engine: "edge",
    voice: "hi-IN-MadhurNeural",
    englishVoice: "en-IN-NeerjaNeural",
    altEnglishVoice: "en-US-ChristopherNeural",
    rate: "+0%",
    fallbackVoice: "Rishi",
    cacheEnabled: true,
    cacheDir: TTS_CACHE_DIR,
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
  ensureDirs();
  let cfg = structuredClone(defaults);
  if (existsSync(CONFIG_FILE)) {
    try {
      cfg = deepMerge(cfg, JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
    } catch (e) {
      console.error(`[config] ignoring unreadable ${CONFIG_FILE}: ${e.message}`);
    }
  }
  const latestPy = resolvePythonRuntime();
  cfg.python = {
    bin: process.env.HV_PYTHON || cfg.python?.bin || latestPy.bin,
    source: process.env.HV_PYTHON ? "env:HV_PYTHON" : latestPy.source,
    verifiedVenv: latestPy.verifiedVenv,
    candidates: latestPy.candidates,
  };
  if (process.env.HV_PORT) cfg.port = Number(process.env.HV_PORT);
  if (process.env.HV_HERMES_CMD) cfg.hermes.command = process.env.HV_HERMES_CMD.trim().split(/\s+/);
  if (process.env.HV_HERMES_FORMAT === "legacy") {
    cfg.hermes.argvTemplate = ["chat", "-q", "{{utterance}}", "--session", "{{sessionId}}"];
  }
  if (process.env.HV_HERMES_CWD) cfg.hermes.cwd = resolve(process.env.HV_HERMES_CWD);
  if (process.env.HV_OMNI_BASE) cfg.omniroute.baseURL = process.env.HV_OMNI_BASE;
  if (process.env.HV_TTS_ENGINE) cfg.tts.engine = process.env.HV_TTS_ENGINE;
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
