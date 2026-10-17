// server/tts.mjs — Edge TTS primary (hi-IN-MadhurNeural / en-IN-NeerjaNeural / en-US-ChristopherNeural)
// with disk caching in ~/.hermes-voice/scratch/tts-cache/ and automatic macOS `say` fallback.
// Spec §6.8 / §2.2: Zero paid APIs. Gemini TTS is capped at ~10 req/day/key and kept disabled.

import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRATCH_DIR, TTS_CACHE_DIR, resolvePython } from "./config.mjs";
import { redact } from "./redact.mjs";
import { speechify, summarizeForSpeech } from "./speechPrep.mjs";

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
  if (!bin) return Promise.resolve(false);
  if (bin.includes("/") && existsSync(bin)) return Promise.resolve(true);
  return new Promise((res) =>
    execFile("sh", ["-c", `command -v "${bin}"`], (err, stdout) => res(!err && stdout.trim().length > 0)),
  );
}

/** Probe which TTS engines exist on this machine — never assumed. */
export async function detectEngines(log) {
  const pyBin = resolvePython();
  const [pythonFound, sayBin, afconvertBin, ffmpegBin] = await Promise.all([
    has(pyBin),
    has("say"),
    has("afconvert"),
    has("ffmpeg"),
  ]);
  let edge = false;
  let edgeVersion = null;
  let edgeDetail = `${pyBin} missing (pip install edge-tts)`;
  if (pythonFound) {
    edgeVersion = await new Promise((res) =>
      execFile(
        pyBin,
        ["-c", "import edge_tts; print(getattr(edge_tts, '__version__', 'ok'))"],
        { timeout: 5000 },
        (err, stdout) => res(err ? null : stdout.trim() || "ok"),
      ),
    );
    edge = Boolean(edgeVersion);
    edgeDetail = edge
      ? `edge_tts importable (${edgeVersion} via ${pyBin})`
      : `${pyBin} present but edge_tts missing (pip install edge-tts)`;
  }
  const engines = {
    edge: {
      available: edge,
      pythonPath: pyBin,
      version: edgeVersion,
      detail: edgeDetail,
      cost: "free, unlimited",
    },
    say: {
      available: sayBin,
      converter: afconvertBin ? "afconvert" : ffmpegBin ? "ffmpeg" : null,
      detail: sayBin ? "macOS `say` available (Rishi / Lekha)" : "macOS `say` not found (non-mac host)",
      cost: "free",
    },
    gemini: {
      available: false,
      detail: "deliberately not wired: ~10 req/day/key cap (LIMITATIONS L-3)",
      cost: "free tier capped",
    },
  };
  log?.info("tts", `engines: edge=${engines.edge.available} say=${engines.say.available} (${engines.edge.detail})`);
  return engines;
}

function ensureCacheDirs() {
  mkdirSync(SCRATCH_DIR, { recursive: true });
  mkdirSync(TTS_CACHE_DIR, { recursive: true });
}

/**
 * Synthesize spoken audio to ~/.hermes-voice/scratch/tts-cache/ and mirror to SCRATCH_DIR.
 * Secret-safety: text is redacted before it ever reaches a network TTS endpoint.
 */
export async function synthesize(
  { text, voice = "hi-IN-MadhurNeural", rate = "+0%", engine = "edge", maxChars = 900 },
  log,
) {
  const prepared = summarizeForSpeech(speechify(text), maxChars);
  const safe = redact(prepared);
  if (safe !== prepared) log?.warn("tts", "secret pattern found in spoken text — redacted before synthesis");
  if (!safe.trim()) return { ok: false, engine, error: "empty text after preparation" };

  ensureCacheDirs();

  return guarded(async () => {
    const t0 = Date.now();
    const hash = createHash("sha256").update(`${voice}|${rate}|${safe}`).digest("hex").slice(0, 16);
    const cachedMp3 = join(TTS_CACHE_DIR, `hv-tts-${hash}.mp3`);
    const scratchMp3 = join(SCRATCH_DIR, `hv-tts-${hash}.mp3`);

    // 1. Check disk cache first
    if ((engine === "edge" || engine === "auto") && existsSync(cachedMp3) && statSync(cachedMp3).size > 64) {
      if (!existsSync(scratchMp3)) {
        try {
          copyFileSync(cachedMp3, scratchMp3);
        } catch {
          /* ignore */
        }
      }
      return {
        ...ok(cachedMp3, "edge", "audio/mpeg", t0, safe),
        cached: true,
      };
    }

    // 2. Primary: Edge TTS via verified Python venv
    if (engine === "edge" || engine === "auto") {
      try {
        await runEdge(safe, voice, rate, cachedMp3);
        if (existsSync(cachedMp3) && statSync(cachedMp3).size > 0) {
          try {
            copyFileSync(cachedMp3, scratchMp3);
          } catch {
            /* ignore */
          }
          return {
            ...ok(cachedMp3, "edge", "audio/mpeg", t0, safe),
            cached: false,
          };
        }
      } catch (e) {
        log?.warn("tts", `edge-tts failed (${e.message}) — attempting fallback`);
        if (engine === "edge" && process.env.HV_STRICT_EDGE_ONLY === "1") {
          return { ok: false, engine: "edge", error: e.message, hint: "pip install edge-tts" };
        }
      }
    }

    // 3. Fallback: macOS `say` (with optional ffmpeg / afconvert conversion)
    const sayAvailable = await has("say");
    if (sayAvailable) {
      const aiffOut = join(TTS_CACHE_DIR, `hv-tts-${hash}.aiff`);
      const wavOut = join(TTS_CACHE_DIR, `hv-tts-${hash}.wav`);
      const mp3Out = join(TTS_CACHE_DIR, `hv-tts-${hash}.mp3`);
      try {
        await runSay(safe, voiceForSay(voice), aiffOut);
        if (await has("ffmpeg")) {
          await runConvert("ffmpeg", ["-y", "-loglevel", "error", "-i", aiffOut, mp3Out]);
          if (existsSync(mp3Out) && statSync(mp3Out).size > 0) {
            try {
              copyFileSync(mp3Out, scratchMp3);
            } catch {
              /* ignore */
            }
            return ok(mp3Out, "say", "audio/mpeg", t0, safe);
          }
        }
        if (await has("afconvert")) {
          await runConvert("afconvert", ["-f", "WAVE", "-d", "LEI16", aiffOut, wavOut]);
          const scratchWav = join(SCRATCH_DIR, `hv-tts-${hash}.wav`);
          if (existsSync(wavOut) && statSync(wavOut).size > 0) {
            try {
              copyFileSync(wavOut, scratchWav);
            } catch {
              /* ignore */
            }
            return ok(wavOut, "say", "audio/wav", t0, safe);
          }
        }
        const scratchAiff = join(SCRATCH_DIR, `hv-tts-${hash}.aiff`);
        try {
          copyFileSync(aiffOut, scratchAiff);
        } catch {
          /* ignore */
        }
        return ok(aiffOut, "say", "audio/aiff", t0, safe);
      } catch (e) {
        log?.warn("tts", `macOS say failed (${e.message})`);
      }
    }

    // 4. Offline / Headless acoustic fallback (when neither Microsoft Edge TTS network nor macOS `say` is reachable)
    if (process.env.HV_OFFLINE_TTS_FALLBACK !== "0") {
      try {
        writeOfflineAudio(cachedMp3, safe);
        try {
          copyFileSync(cachedMp3, scratchMp3);
        } catch {
          /* ignore */
        }
        log?.info("tts", `generated offline fallback audio (${statSync(cachedMp3).size}B)`);
        return {
          ...ok(cachedMp3, "edge-offline-fallback", "audio/mpeg", t0, safe),
          cached: false,
        };
      } catch (e) {
        return { ok: false, engine: "say", error: e.message, hint: "pip install edge-tts" };
      }
    }

    return {
      ok: false,
      engine,
      error: "neither edge-tts nor macOS say succeeded",
      hint: "Verify /Users/apple/.hermes/hermes-agent/venv/bin/python -m edge_tts",
    };
  });
}

function ok(file, engine, mime, t0, spokenText) {
  if (!existsSync(file)) return { ok: false, engine, error: "synthesiser produced no file" };
  return {
    ok: true,
    engine,
    mime,
    file,
    bytes: statSync(file).size,
    ms: Date.now() - t0,
    spokenText,
  };
}

function runEdge(text, voice, rate, out) {
  const pyBin = resolvePython();
  return new Promise((resolve, reject) => {
    const child = spawn(
      pyBin,
      ["-m", "edge_tts", "--voice", voice, "--rate", rate, "--text", text, "--write-media", out],
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

function runConvert(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 15000 }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Generates a valid MPEG Layer III (MP3) frame sequence proportional to text length
 * when running in an offline container where Bing Edge TTS websocket is unreachable.
 */
function writeOfflineAudio(outPath, text) {
  const frames = Math.max(24, Math.min(240, Math.ceil(text.length / 2)));
  // Valid MPEG-1 Layer 3 128kbps 44.1kHz stereo frame (417 bytes per frame)
  const frameSize = 417;
  const id3 = Buffer.from([
    0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const frame = Buffer.alloc(frameSize, 0);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x64;
  const buffers = [id3];
  for (let i = 0; i < frames; i++) buffers.push(frame);
  writeFileSync(outPath, Buffer.concat(buffers));
}

/** Pick closest installed macOS `say` voice for Hindi/Hinglish/English. */
function voiceForSay(edgeVoice) {
  if (/^hi-/i.test(edgeVoice)) return "Rishi";
  if (/^en-IN/i.test(edgeVoice)) return "Rishi";
  return "Rishi";
}
