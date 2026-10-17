// server/tts.mjs — unlimited-free TTS first (Edge TTS), macOS `say` fallback (v1.1).
// Spec §6.8 / §24: Edge TTS is primary (free, uncapped) using the verified Python venv
// at /Users/apple/.hermes/hermes-agent/venv/bin/python with SHA-256 disk caching in
// ~/.hermes-voice/scratch/tts-cache/ and mid-task Hinglish progress ping synthesis.

import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { resolvePython, SCRATCH_DIR, TTS_CACHE_DIR } from "./config.mjs";
import { redact } from "./redact.mjs";
import { speechify, summarizeForSpeech } from "./speechPrep.mjs";

export const PROGRESS_PING_PHRASES = [
  "Kaam chal raha hai, check kar raha hoon...",
  "Abhi process ho raha hai, bas thoda aur wait karo...",
  "Hermes tools chala raha hai, main nazar rakh raha hoon...",
];

const CONCURRENCY = 2;
let inFlight = 0;
const queue = [];

function next() {
  if (inFlight >= CONCURRENCY || queue.length === 0) return;
  inFlight++;
  const job = queue.shift();
  job().finally(() => {
    inFlight--;
    next();
  });
}

function guarded(fn) {
  return new Promise((resolve, reject) => {
    queue.push(async () => {
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      }
    });
    next();
  });
}

function has(bin) {
  if (bin.includes("/") && existsSync(bin)) return Promise.resolve(true);
  return new Promise((res) => execFile("sh", ["-c", `command -v "${bin}"`], (err, stdout) => res(!err && stdout.trim().length > 0)));
}

/** Which engines actually exist on this machine — probed, never assumed. */
export async function detectEngines(log) {
  const pyBin = resolvePython();
  const [pythonFound, sayBin] = await Promise.all([has(pyBin), has("say")]);
  let edge = false;
  let edgeDetail = `${pyBin} missing (pip install edge-tts)`;
  if (pythonFound) {
    const versionOut = await new Promise((res) =>
      execFile(
        pyBin,
        ["-c", "import edge_tts; print(getattr(edge_tts, '__version__', 'installed'))"],
        { timeout: 6000 },
        (err, stdout) => res(err ? null : stdout.trim()),
      ),
    );
    edge = Boolean(versionOut);
    edgeDetail = edge
      ? `edge_tts (${versionOut}) importable via ${pyBin}`
      : `${pyBin} present but edge_tts missing (pip install edge-tts)`;
  }
  const engines = {
    edge: { available: edge, detail: edgeDetail, pythonPath: pyBin, cost: "free, unlimited" },
    say: { available: sayBin, detail: sayBin ? "macOS `say` available (Rishi/Lekha)" : "macOS `say` not found (non-mac host)", cost: "free" },
    gemini: { available: false, detail: "deliberately not wired: ~10 req/day/key cap (LIMITATIONS L-3)", cost: "free tier capped" },
  };
  log?.info("tts", `engines: edge=${engines.edge.available} say=${engines.say.available} (${engines.edge.detail})`);
  return engines;
}

function ensureCacheDirs() {
  mkdirSync(SCRATCH_DIR, { recursive: true });
  mkdirSync(TTS_CACHE_DIR, { recursive: true });
}

function cacheKey(engine, voice, rate, text) {
  return createHash("sha256").update(`${engine}|${voice}|${rate}|${text}`).digest("hex").slice(0, 16);
}

/**
 * Synthesize a conversational Hinglish mid-task progress ping (>12s silence during active task).
 * Cached by SHA-256 in ~/.hermes-voice/scratch/tts-cache/ so repeated pings resolve in <1ms.
 */
export async function synthesizeProgressPing(
  { index = 0, text, voice = "hi-IN-MadhurNeural", rate = "+0%", engine = "auto" } = {},
  log,
) {
  const phrase = text || PROGRESS_PING_PHRASES[index % PROGRESS_PING_PHRASES.length];
  try {
    const res = await synthesize({ text: phrase, voice, rate, engine, maxChars: 240 }, log);
    if (res.ok && res.file) {
      return {
        ok: true,
        text: phrase,
        engine: res.engine,
        file: res.file,
        audioUrl: `/api/media/${basename(res.file)}`,
        cached: Boolean(res.cached),
      };
    }
    return { ok: false, text: phrase, engine: res.engine ?? "none", audioUrl: null, error: res.error };
  } catch (e) {
    return { ok: false, text: phrase, engine: "none", audioUrl: null, error: e.message };
  }
}

/**
 * Synthesize to a cached file in ~/.hermes-voice/scratch/tts-cache/ and expose in scratch.
 * Secret-safety: text is redacted before it ever reaches a network TTS endpoint.
 */
export async function synthesize({ text, voice = "hi-IN-MadhurNeural", rate = "+0%", engine = "auto", maxChars = 900 }, log) {
  const prepared = summarizeForSpeech(speechify(text), maxChars);
  const safe = redact(prepared);
  if (safe !== prepared) log?.warn("tts", "secret pattern found in spoken text — redacted before synthesis");
  if (!safe.trim()) return { ok: false, engine, error: "empty text after preparation" };

  ensureCacheDirs();

  return guarded(async () => {
    const t0 = Date.now();
    const normalizedRate = typeof rate === "number" ? `${rate >= 1 ? "+" : ""}${Math.round((rate - 1) * 100)}%` : String(rate || "+0%");
    const hash = cacheKey(engine, voice, normalizedRate, safe);

    // 1. Check Edge TTS cache first
    if (engine === "edge" || engine === "auto") {
      const cachedMp3 = join(TTS_CACHE_DIR, `hv-tts-${hash}.mp3`);
      const scratchMp3 = join(SCRATCH_DIR, `hv-tts-${hash}.mp3`);
      if (existsSync(cachedMp3) && statSync(cachedMp3).size > 128) {
        if (!existsSync(scratchMp3)) copyFileSync(cachedMp3, scratchMp3);
        return { ...ok(scratchMp3, "edge", "audio/mpeg", t0, safe), cached: true };
      }

      try {
        await runEdge(safe, voice, normalizedRate, cachedMp3);
        if (existsSync(cachedMp3) && statSync(cachedMp3).size > 0) {
          copyFileSync(cachedMp3, scratchMp3);
          return { ...ok(scratchMp3, "edge", "audio/mpeg", t0, safe), cached: false };
        }
      } catch (e) {
        if (engine === "edge") {
          // Even when configured as "edge", try macOS `say` if available so user still hears audio
          const sayAvailable = await has("say");
          if (!sayAvailable) {
            return { ok: false, engine: "edge", error: e.message, hint: "Verify /Users/apple/.hermes/hermes-agent/venv/bin/python -m pip install edge-tts" };
          }
          log?.warn("tts", `edge-tts failed (${e.message}) — auto-falling back to macOS \`say\``);
        } else {
          log?.warn("tts", `edge-tts failed (${e.message}) — falling back to \`say\``);
        }
      }
    }

    // 2. macOS `say` fallback with optional afconvert/ffmpeg conversion to wav/mp3 for browser compatibility
    const cachedWav = join(TTS_CACHE_DIR, `hv-tts-${hash}.wav`);
    const scratchWav = join(SCRATCH_DIR, `hv-tts-${hash}.wav`);
    if (existsSync(cachedWav) && statSync(cachedWav).size > 128) {
      if (!existsSync(scratchWav)) copyFileSync(cachedWav, scratchWav);
      return { ...ok(scratchWav, "say", "audio/wav", t0, safe), cached: true };
    }

    const aiffOut = join(SCRATCH_DIR, `hv-tts-${hash}.aiff`);
    try {
      await runSay(safe, voiceForSay(voice), aiffOut);
      const converted = await convertAiffToPlayable(aiffOut, cachedWav);
      if (converted && existsSync(cachedWav)) {
        copyFileSync(cachedWav, scratchWav);
        return { ...ok(scratchWav, "say", "audio/wav", t0, safe), cached: false };
      }
      return { ...ok(aiffOut, "say", "audio/aiff", t0, safe), cached: false };
    } catch (e) {
      return { ok: false, engine: "say", error: e.message, hint: "Ensure edge-tts is installed in Python venv or macOS `say` is available" };
    }
  });
}

function ok(file, engine, mime, t0, spokenText) {
  if (!existsSync(file)) return { ok: false, engine, error: "synthesiser produced no file" };
  return { ok: true, engine, mime, file, bytes: statSync(file).size, ms: Date.now() - t0, spokenText };
}

function runEdge(text, voice, rate, out) {
  const pyBin = resolvePython();
  return new Promise((resolve, reject) => {
    const child = spawn(
      pyBin,
      ["-m", "edge_tts", "--voice", voice, `--rate=${rate}`, "--text", text, "--write-media", out],
      {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, PYTHONIOENCODING: "utf-8", LANG: "en_US.UTF-8" },
      },
    );
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString().slice(0, 2000)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("edge-tts timeout (30s)"));
    }, 30000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`cannot spawn ${pyBin}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`edge-tts exit ${code}: ${err.trim().slice(-200) || "no stderr"}`));
    });
  });
}

function runSay(text, voice, out) {
  return new Promise((resolve, reject) => {
    const args = voice ? ["-v", voice, "-o", out, text] : ["-o", out, text];
    const child = spawn("say", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("say timeout (30s)"));
    }, 30000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`cannot spawn say: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`say exit ${code}: ${err.trim()}`));
    });
  });
}

async function convertAiffToPlayable(aiffPath, wavPath) {
  if (await has("afconvert")) {
    return new Promise((res) => {
      execFile("afconvert", ["-f", "WAVE", "-d", "LEI16@22050", aiffPath, wavPath], { timeout: 10000 }, (err) => res(!err));
    });
  }
  if (await has("ffmpeg")) {
    return new Promise((res) => {
      execFile("ffmpeg", ["-y", "-i", aiffPath, wavPath], { timeout: 10000 }, (err) => res(!err));
    });
  }
  return false;
}

/** Pick the closest installed macOS `say` voice for Indian Hinglish/Hindi. */
function voiceForSay(edgeVoice) {
  if (/^hi-/i.test(edgeVoice)) return "Lekha";
  if (/^en-IN/i.test(edgeVoice)) return "Rishi";
  return "Rishi";
}
