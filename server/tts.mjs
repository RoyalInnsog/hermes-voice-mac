// server/tts.mjs — unlimited-free TTS first (Edge TTS), macOS `say` fallback.
// Spec §6.8 / §24: Edge TTS is primary (free, uncapped); Gemini TTS is opt-in and
// capped at ~10 req/day/key so it is deliberately NOT wired here (LIMITATIONS L-3).

import { spawn, execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SCRATCH_DIR } from "./config.mjs";
import { redact } from "./redact.mjs";
import { speechify, summarizeForSpeech } from "./speechPrep.mjs";

function resolvePython() {
  if (process.env.HV_PYTHON && existsSync(process.env.HV_PYTHON)) return process.env.HV_PYTHON;
  const venvPy = join(homedir(), ".hermes/hermes-agent/venv/bin/python");
  if (existsSync(venvPy)) return venvPy;
  return "python3";
}

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
  return new Promise((res) => execFile("sh", ["-c", `command -v ${bin}`], (err, stdout) => res(!err && stdout.trim().length > 0)));
}

/** Which engines actually exist on this machine — probed, never assumed. */
export async function detectEngines(log) {
  const pyBin = resolvePython();
  const [pythonFound, sayBin] = await Promise.all([has(pyBin), has("say")]);
  let edge = false;
  let edgeDetail = `${pyBin} not found`;
  if (pythonFound) {
    edge = await new Promise((res) =>
      execFile(pyBin, ["-c", "import edge_tts; print(edge_tts.__version__ if hasattr(edge_tts,'__version__') else 'ok')"], (err) => res(!err)),
    );
    edgeDetail = edge ? "edge_tts importable" : `${pyBin} present but edge_tts missing (pip install edge-tts)`;
  }
  const engines = {
    edge: { available: edge, detail: edgeDetail, cost: "free, unlimited" },
    say: { available: sayBin, detail: sayBin ? "macOS `say` available" : "macOS `say` not found (non-mac host)", cost: "free" },
    gemini: { available: false, detail: "deliberately not wired: ~10 req/day/key cap (LIMITATIONS L-3)", cost: "free tier capped" },
  };
  log?.info("tts", `engines: edge=${engines.edge.available} say=${engines.say.available} (${engines.edge.detail})`);
  return engines;
}

/**
 * Synthesize to a scratch file.
 * Secret-safety: text is redacted before it ever reaches a network TTS endpoint.
 */
export async function synthesize({ text, voice = "hi-IN-MadhurNeural", rate = "+0%", engine = "edge", maxChars = 900 }, log) {
  const prepared = summarizeForSpeech(speechify(text), maxChars);
  const safe = redact(prepared);
  if (safe !== prepared) log?.warn("tts", "secret pattern found in spoken text — redacted before synthesis");
  if (!safe.trim()) return { ok: false, engine, error: "empty text after preparation" };

  return guarded(async () => {
    const t0 = Date.now();
    const id = crypto.randomUUID().slice(0, 8);

    if (engine === "edge" || engine === "auto") {
      const out = join(SCRATCH_DIR, `hv-tts-${id}.mp3`);
      try {
        await runEdge(safe, voice, rate, out);
        return ok(out, "edge", "audio/mpeg", t0, safe);
      } catch (e) {
        if (engine === "edge") return { ok: false, engine: "edge", error: e.message, hint: "pip install edge-tts" };
        log?.warn("tts", `edge-tts failed (${e.message}) — falling back to \`say\``);
      }
    }

    const out = join(SCRATCH_DIR, `hv-tts-${id}.aiff`);
    try {
      await runSay(safe, voiceForSay(voice), out);
      return ok(out, "say", "audio/aiff", t0, safe);
    } catch (e) {
      return { ok: false, engine: "say", error: e.message };
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
    const child = spawn(pyBin, ["-m", "edge_tts", "--voice", voice, "--rate", rate, "--text", text, "--write-media", out], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", LANG: "en_US.UTF-8" },
    });
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

/** hi-IN-MadhurNeural has no `say` equivalent; pick the closest installed voice. */
function voiceForSay(edgeVoice) {
  if (/^hi-/i.test(edgeVoice)) return "Lekha";
  if (/^en-IN/i.test(edgeVoice)) return "Rishi";
  return null;
}
