// server/tts.mjs — Hermes Voice v1.0 Edge TTS + macOS `say` fallback with disk caching (Spec §2.2).
//
// Python resolution order (via config.mjs):
//   1. process.env.HV_PYTHON
//   2. /Users/apple/.hermes/hermes-agent/venv/bin/python (verified edge-tts 7.3.1 venv)
//   3. ~/.hermes/installs/*/venv/bin/python
//   4. python3
//
// Cache directory: ~/.hermes-voice/scratch/tts-cache/ (auto-created recursively).

import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SCRATCH_DIR, TTS_CACHE_DIR, resolvePythonRuntime } from "./config.mjs";
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
  return new Promise((res) =>
    execFile("sh", ["-c", `command -v ${bin}`], (err, stdout) => res(!err && stdout.trim().length > 0)),
  );
}

/**
 * Probes the resolved Python runtime and macOS `say` / `afconvert` / `ffmpeg`.
 * Never assumes a package is installed without probing it.
 */
export async function detectEngines(log) {
  mkdirSync(TTS_CACHE_DIR, { recursive: true });
  const py = resolvePythonRuntime();
  const [sayBin, afconvertBin, ffmpegBin] = await Promise.all([has("say"), has("afconvert"), has("ffmpeg")]);

  let edge = false;
  let edgeVersion = null;
  let edgeDetail = `python runtime (${py.bin}) not found`;

  const pycheck = await new Promise((res) =>
    execFile(
      py.bin,
      ["-c", "import edge_tts; print(getattr(edge_tts, '__version__', 'installed'))"],
      { timeout: 6000 },
      (err, stdout, stderr) => res({ ok: !err, out: (stdout || "").trim(), err: (stderr || err?.message || "").trim() }),
    ),
  );

  if (pycheck.ok) {
    edge = true;
    edgeVersion = pycheck.out || "installed";
    edgeDetail = `edge-tts ${edgeVersion} via ${py.bin} (${py.source})`;
  } else {
    edgeDetail = `${py.bin} (${py.source}) missing edge_tts (${pycheck.err.slice(0, 120) || "pip install edge-tts"})`;
  }

  const engines = {
    edge: {
      available: edge,
      version: edgeVersion,
      pythonBin: py.bin,
      pythonSource: py.source,
      verifiedVenv: py.verifiedVenv,
      detail: edgeDetail,
      cost: "free, unlimited",
    },
    say: {
      available: sayBin,
      converter: afconvertBin ? "afconvert" : ffmpegBin ? "ffmpeg" : null,
      detail: sayBin
        ? `macOS \`say\` available${afconvertBin ? " + afconvert" : ffmpegBin ? " + ffmpeg" : ""}`
        : "macOS `say` not found (non-macOS host)",
      cost: "free, local",
    },
    gemini: {
      available: false,
      detail: "deliberately not wired: ~10 req/day/key free-tier cap (Spec §1.5)",
      cost: "free tier capped",
    },
  };
  log?.info("tts", `engines: edge=${engines.edge.available} (${engines.edge.pythonBin}) say=${engines.say.available}`);
  return engines;
}

/**
 * Synthesizes speech into ~/.hermes-voice/scratch/tts-cache/ (or SCRATCH_DIR).
 * Uses SHA-256 content-addressed caching for instant replay of repeated prompts.
 */
export async function synthesize(
  {
    text,
    voice = "hi-IN-MadhurNeural",
    rate = "+0%",
    engine = "edge",
    maxChars = 900,
    cacheDir = TTS_CACHE_DIR,
  },
  log,
) {
  const prepared = summarizeForSpeech(speechify(text), maxChars);
  const safe = redact(prepared);
  if (safe !== prepared) log?.warn("tts", "secret pattern found in spoken text — redacted before synthesis");
  if (!safe.trim()) return { ok: false, engine, error: "empty text after preparation" };

  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(SCRATCH_DIR, { recursive: true });

  const hash = createHash("sha256").update(`${voice}|${rate}|${safe}`).digest("hex").slice(0, 18);

  return guarded(async () => {
    const t0 = Date.now();
    const py = resolvePythonRuntime();

    if (engine === "edge" || engine === "auto") {
      const cachedMp3 = join(cacheDir, `hv-tts-${hash}.mp3`);
      if (existsSync(cachedMp3) && statSync(cachedMp3).size > 128) {
        return okResult(cachedMp3, "edge", "audio/mpeg", t0, safe, true);
      }
      try {
        await runEdge(py.bin, safe, voice, rate, cachedMp3);
        return okResult(cachedMp3, "edge", "audio/mpeg", t0, safe, false);
      } catch (e) {
        if (engine === "edge" && !(await has("say"))) {
          return {
            ok: false,
            engine: "edge",
            pythonBin: py.bin,
            error: e.message,
            hint: `Verify ${py.bin} -m pip install edge-tts`,
          };
        }
        log?.warn("tts", `edge-tts failed (${e.message}) — falling back to macOS \`say\``);
      }
    }

    const aiffOut = join(cacheDir, `hv-tts-${hash}.aiff`);
    const wavOut = join(cacheDir, `hv-tts-${hash}.wav`);
    try {
      if (existsSync(wavOut) && statSync(wavOut).size > 128) {
        return okResult(wavOut, "say", "audio/wav", t0, safe, true);
      }
      await runSay(safe, voiceForSay(voice), aiffOut);
      if (await has("afconvert")) {
        await runConvert("afconvert", ["-f", "WAVE", "-d", "LEI16@22050", aiffOut, wavOut]);
        if (existsSync(wavOut)) return okResult(wavOut, "say", "audio/wav", t0, safe, false);
      } else if (await has("ffmpeg")) {
        await runConvert("ffmpeg", ["-y", "-i", aiffOut, wavOut]);
        if (existsSync(wavOut)) return okResult(wavOut, "say", "audio/wav", t0, safe, false);
      }
      return okResult(aiffOut, "say", "audio/aiff", t0, safe, false);
    } catch (e) {
      return { ok: false, engine: "say", error: e.message, hint: "Install edge-tts or run on macOS with `say`" };
    }
  });
}

function okResult(file, engine, mime, t0, spokenText, cached = false) {
  if (!existsSync(file)) return { ok: false, engine, error: "synthesiser produced no file" };
  return {
    ok: true,
    engine,
    mime,
    file,
    cached,
    bytes: statSync(file).size,
    ms: Date.now() - t0,
    spokenText,
  };
}

function runEdge(pythonBin, text, voice, rate, out) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      pythonBin,
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
      reject(new Error(`cannot spawn ${pythonBin}: ${e.message}`));
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
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 10000 }, () => resolve());
  });
}

function voiceForSay(edgeVoice) {
  if (/^hi-/i.test(edgeVoice)) return "Lekha";
  if (/^en-IN/i.test(edgeVoice)) return "Rishi";
  return "Rishi";
}
