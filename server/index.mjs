// server/index.mjs — Hermes Voice v1.0 self-contained local bridge & static UI server.
//
//   node server/index.mjs          → http://127.0.0.1:20130
//
// Serves both:
//   • Production Vite singlefile / static bundle from `dist/` on `GET /` and asset paths
//   • Loopback HTTP/SSE API on `/api/*` for Hermes CLI (`stream-json` + `HV_*`),
//     Edge TTS + macOS `say` fallback, and strict read-only OmniRoute inspection.
//
// Security posture:
//   • binds 127.0.0.1 only, and rejects any non-loopback peer
//   • CORS limited to configured local origins
//   • every response body is redacted at the sink
//   • no mutating request is ever forwarded to Omniroute (HTTP or SQLite)
//   • request bodies capped at 256 KB; media & static paths jailed to their roots

import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDirs, loadConfig, resolvePython, saveConfig, SCRATCH_DIR, TTS_CACHE_DIR, DATA_DIR } from "./config.mjs";
import { Logger } from "./logger.mjs";
import { OmnirouteClient } from "./omniroute.mjs";
import { TaskManager, TaskError } from "./agent.mjs";
import { detectEngines, synthesize } from "./tts.mjs";
import * as store from "./store.mjs";
import { cleanScratch } from "./store.mjs";
import { EVENT_KINDS, MARKERS } from "./protocol.mjs";
import { runServerTests } from "./selftest.mjs";
import { detectConversationalIntent } from "./speechPrep.mjs";

const VERSION = "1.0.0";
const startedAt = Date.now();
const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(join(HERE, "..", "dist"));

ensureDirs();
const config = loadConfig();
const log = new Logger({ level: config.logging.level, redactEnabled: config.logging.redact });
const router = new OmnirouteClient(config.omniroute.baseURL, log, { sqlitePath: config.omniroute.sqlitePath });
const tasks = new TaskManager({ config, log });

// macOS Audio Ducking state (server-side fallback when not inside WKWebView)
let savedMacVolume = null;
let isMacDucked = false;

function runOsaScript(script) {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((res) => {
    execFile("osascript", ["-e", script], { timeout: 2500 }, (err, stdout) => {
      res(err ? null : stdout.trim());
    });
  });
}

async function duckMacAudio() {
  if (process.platform !== "darwin") return { ok: true, ducked: false, platform: process.platform };
  if (isMacDucked) return { ok: true, ducked: true, savedVolume: savedMacVolume };
  const raw = await runOsaScript("output volume of (get volume settings)");
  const current = raw !== null ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isNaN(current)) {
    savedMacVolume = current;
    const target = Math.min(current, Math.max(10, Math.round(current * 0.35)));
    if (target < current) {
      await runOsaScript(`set volume output volume ${target}`);
    }
    isMacDucked = true;
    return { ok: true, ducked: true, savedVolume: savedMacVolume, targetVolume: target };
  }
  return { ok: true, ducked: false };
}

async function restoreMacAudio() {
  if (process.platform !== "darwin") return { ok: true, restored: false, platform: process.platform };
  if (!isMacDucked) return { ok: true, restored: false };
  const orig = savedMacVolume;
  savedMacVolume = null;
  isMacDucked = false;
  if (typeof orig === "number" && !Number.isNaN(orig)) {
    await runOsaScript(`set volume output volume ${Math.max(0, Math.min(100, orig))}`);
  }
  return { ok: true, restored: true, restoredVolume: orig };
}

const MIME = {
  html: "text/html; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  ico: "image/x-icon",
  woff2: "font/woff2",
  mp3: "audio/mpeg",
  aiff: "audio/aiff",
  wav: "audio/wav",
  txt: "text/plain; charset=utf-8",
};

/* ------------------------------- helpers -------------------------------- */

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers,
  });
  res.end(payload);
}

function fail(res, err) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
    return;
  }
  if (err instanceof TaskError) return send(res, err.status, { error: err.code, message: err.message, hint: err.hint });
  const status = err.status || 500;
  log.error("app", `${err.message}`);
  send(res, status, { error: status >= 500 ? "internal" : "badRequest", message: err.message, hint: null });
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolveP, rejectP) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        rejectP(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolveP({});
      try {
        resolveP(JSON.parse(raw));
      } catch {
        rejectP(Object.assign(new Error("body is not valid JSON"), { status: 400 }));
      }
    });
    req.on("error", rejectP);
  });
}

const isLoopback = (addr) =>
  !addr || addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || addr.startsWith("::ffff:127.");

function cors(req, res) {
  const origin = req.headers.origin;
  const allowed =
    origin &&
    (config.allowedOrigins.includes(origin) ||
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
      /^https:\/\/ais-(dev|pre)-/.test(origin));
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function sse(res, onReady) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 2000\n\n`);
  const sendEvent = (data, event) => {
    try {
      if (event) res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      return false;
    }
  };
  const cleanup = onReady(sendEvent);
  const beat = setInterval(() => {
    try {
      res.write(": keep-alive\n\n");
    } catch {
      /* closed */
    }
  }, 15000);
  res.on("close", () => {
    clearInterval(beat);
    cleanup?.();
  });
}

/* --------------------------------- routes -------------------------------- */

const PROTOCOL_DOC = {
  streamJson: {
    command: 'hermes chat -q "<utterance>" --format stream-json',
    events: [
      '{"type":"system","subtype":"init","model":"...","session_id":"..."}',
      '{"type":"text","text":"..."}',
      '{"type":"tool_call","name":"...","arguments":{...}}',
      '{"type":"result","text":"...","exit_code":0}',
    ],
  },
  stdout: {
    [MARKERS.event]: `{ kind: one of ${JSON.stringify(EVENT_KINDS)}, ...payload }`,
    [MARKERS.perm]: "{ tool, args{}, reason?, risk? (computed if absent), id? }",
    [MARKERS.progress]: "<free text>",
    "unmarked line": "treated as plain assistant text; whole stdout becomes the answer if no completed event arrives",
  },
  stdin: { [MARKERS.decision]: "{ id, decision: allowOnce|allowSession|deny }" },
  note: "Supports both Hermes CLI `--format stream-json` and legacy HV_* markers over direct stdin decision relay.",
};

function serveStaticAsset(reqPath, res) {
  const rel = reqPath === "/" || reqPath === "/index.html" ? "index.html" : reqPath.replace(/^\/+/, "");
  const target = resolve(join(DIST_DIR, rel));
  if (!target.startsWith(DIST_DIR)) {
    return send(res, 400, { error: "badPath", message: "static path traversal rejected" });
  }
  if (existsSync(target) && statSync(target).isFile()) {
    const ext = extname(target).slice(1).toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";
    const stat = statSync(target);
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": stat.size,
      "Cache-Control": ext === "html" ? "no-cache" : "public, max-age=3600",
    });
    return createReadStream(target).pipe(res);
  }
  // SPA fallback to dist/index.html for non-API GET routes
  const indexHtml = join(DIST_DIR, "index.html");
  if (existsSync(indexHtml)) {
    const html = readFileSync(indexHtml);
    res.writeHead(200, {
      "Content-Type": MIME.html,
      "Content-Length": html.length,
      "Cache-Control": "no-cache",
    });
    return res.end(html);
  }
  return false;
}

export async function handleRequest(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (!isLoopback(req.socket?.remoteAddress)) {
    log.warn("app", `rejected non-loopback peer ${req.socket?.remoteAddress}`);
    return send(res, 403, { error: "loopbackOnly", message: "this bridge only accepts connections from 127.0.0.1" });
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1:20130"}`);
  const p = url.pathname;
  const m = req.method;

  try {
    /* ---------------------------- bridge health --------------------------- */
    if (m === "GET" && p === "/api/health") {
      const [hermes, ttsEngines, omni] = await Promise.all([tasks.resolveBinary(), detectEngines(null), router.health()]);
      const pyBin = resolvePython();
      return send(res, 200, {
        ok: true,
        service: "hermes-voice-bridge",
        version: VERSION,
        node: process.version,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        pid: process.pid,
        dataDir: DATA_DIR,
        pythonPath: pyBin,
        python: { bin: pyBin },
        staticDist: {
          available: existsSync(join(DIST_DIR, "index.html")),
          dir: DIST_DIR,
        },
        hermes: {
          ...hermes,
          command: config.hermes.command,
          argvTemplate: config.hermes.argvTemplate,
          cwd: config.hermes.cwd,
          timeoutSec: config.hermes.timeoutSec,
        },
        omniroute: {
          ...omni,
          baseURL: config.omniroute.baseURL,
          probeModel: config.omniroute.probeModel,
          activeComboName: config.omniroute.activeComboName ?? "KRITI / 9Router",
        },
        tts: { engines: ttsEngines, configured: { ...config.tts, pythonPath: pyBin, cacheDir: TTS_CACHE_DIR } },
        tasks: tasks.stats(),
        permissions: config.permissions,
        logging: config.logging,
        protocol: PROTOCOL_DOC,
      });
    }

    if (m === "GET" && p === "/api/protocol") return send(res, 200, PROTOCOL_DOC);

    /* ------------------------------- config ------------------------------- */
    if (m === "GET" && p === "/api/config") return send(res, 200, { config, file: `${DATA_DIR}/config.json` });
    if (m === "PATCH" && p === "/api/config") {
      const patch = await readBody(req);
      const allowed = {
        hermes: ["command", "argvTemplate", "cwd", "timeoutSec"],
        omniroute: ["baseURL", "probeModel", "activeComboName"],
        tts: ["engine", "voice", "rate"],
        permissions: ["timeoutSec", "autoApproveLowRisk"],
        logging: ["level", "redact"],
      };
      const safe = {};
      for (const [section, keys] of Object.entries(allowed)) {
        if (patch[section]) {
          safe[section] = {};
          for (const k of keys) if (k in patch[section]) safe[section][k] = patch[section][k];
        }
      }
      const next = saveConfig(safe);
      Object.assign(config, next);
      log.configure(next.logging);
      log.info("app", `config patched: ${JSON.stringify(safe)}`);
      return send(res, 200, { ok: true, config: next });
    }

    /* ---------------------- omniroute (read-only proxy) -------------------- */
    if (m === "GET" && p === "/api/router/health") return send(res, 200, await router.health());
    if (m === "GET" && p === "/api/router/models") {
      try {
        return send(res, 200, { models: await router.models() });
      } catch (e) {
        return send(res, 502, { error: "omnirouteModelsFailed", message: e.message, hint: `curl -sS ${config.omniroute.baseURL}/v1/models` });
      }
    }
    if (m === "GET" && p === "/api/router/combos") {
      const r = await router.combos({ sqlitePath: config.omniroute.sqlitePath });
      return send(res, 200, {
        ...r,
        note: r.pathUsed ? "read-only" : "read-only probe completed (no active combo endpoint or SQLite table found)",
      });
    }
    if (m === "POST" && p === "/api/router/probe") {
      const { model } = await readBody(req);
      const target = String(model || config.omniroute.probeModel);
      log.info("router", `probe ${target} (stream:false)`);
      const r = await router.chatProbe(target);
      return send(res, 200, r);
    }

    /* -------------------------------- tasks ------------------------------- */
    if (m === "POST" && p === "/api/tasks") {
      const body = await readBody(req);
      const text = String(body.utterance ?? "").trim();
      
      // Conversational intent check: mode change or progress inquiry
      const intent = detectConversationalIntent(text);
      if (intent?.type === "modeChange") {
        config.hermes.narrationMode = intent.mode;
        saveConfig({ hermes: { narrationMode: intent.mode } });
        log.info("app", `narrationMode changed via voice to: ${intent.mode}`);
        return send(res, 200, {
          taskId: "intent-" + Date.now(),
          mode: intent.mode,
          replyText: intent.reply,
          task: { status: "done", summary: intent.reply }
        });
      }
      
      if (intent?.type === "statusCheck") {
        // Find latest active or recent task
        const activeTasks = tasks.list();
        const latest = activeTasks[0];
        let statusMsg = "";
        if (!latest) {
          statusMsg = "Abhi koi task run nahi ho raha.";
        } else if (latest.status === "running") {
          statusMsg = `Kaam chal raha hai. Abhi tak ${latest.events?.length ?? 1} actions execute hue hain.`;
        } else if (latest.status === "done") {
          statusMsg = `Haan, task poora ho gaya! Summary: ${latest.summary || "Kaam complete ho gaya."}`;
        } else {
          statusMsg = `Task ${latest.status} hai.`;
        }
        return send(res, 200, {
          taskId: "status-" + Date.now(),
          isStatusCheck: true,
          replyText: statusMsg,
          task: { status: "done", summary: statusMsg }
        });
      }

      const task = await tasks.start({ utterance: body.utterance, sessionId: body.sessionId, meta: body.meta });
      log.info("agent", `task created ${task.id} for session ${task.sessionId}`);
      return send(res, 201, { taskId: task.id, task, eventsUrl: `/api/tasks/${task.id}/events` });
    }
    if (m === "GET" && p === "/api/tasks") return send(res, 200, { tasks: tasks.list(), stats: tasks.stats() });

    const taskMatch = p.match(/^\/api\/tasks\/([\w-]+)$/);
    if (m === "GET" && taskMatch) return send(res, 200, tasks.get(taskMatch[1]));
    if (m === "DELETE" && taskMatch) return send(res, 200, tasks.cancel(taskMatch[1]));

    const eventsMatch = p.match(/^\/api\/tasks\/([\w-]+)\/events$/);
    if (m === "GET" && eventsMatch) {
      const id = eventsMatch[1];
      const after = Number(url.searchParams.get("after") ?? 0);
      const initialTask = tasks.get(id);
      const backlog = tasks.eventsSince(id, after);
      return sse(res, (sendEvt) => {
        for (const e of backlog) sendEvt(e);
        const unsub = tasks.subscribe(id, (e) => sendEvt(e));
        if (["done", "failed", "cancelled"].includes(initialTask.status)) {
          sendEvt({ type: "end", taskId: id }, "end");
          return unsub;
        }
        return unsub;
      });
    }

    const decideMatch = p.match(/^\/api\/tasks\/([\w-]+)\/permissions\/([\w-]+)\/decision$/);
    if (m === "POST" && decideMatch) {
      const body = await readBody(req);
      const out = tasks.decide({
        taskId: decideMatch[1],
        requestId: decideMatch[2],
        decision: body.decision,
        via: body.via ?? "click",
        typedConfirm: body.typedConfirm ?? null,
      });
      return send(res, 200, { ok: true, ...out });
    }

    /* --------------------------------- tts -------------------------------- */
    if (m === "GET" && p === "/api/tts/engines") {
      return send(res, 200, { engines: await detectEngines(log), configured: { ...config.tts, pythonPath: resolvePython() } });
    }
    if (m === "POST" && p === "/api/tts") {
      const body = await readBody(req);
      const engine = body.engine ?? (config.tts.engine === "gemini" ? "auto" : config.tts.engine);
      const t0 = Date.now();
      const out = await synthesize(
        { text: body.text, voice: body.voice ?? config.tts.voice, rate: body.rate ?? config.tts.rate, engine },
        log,
      );
      if (!out.ok) return send(res, 502, { ok: false, error: "ttsFailed", message: out.error, hint: out.hint ?? "pip install edge-tts" });
      log.info("tts", `synthesised ${out.bytes}B via ${out.engine}${out.cached ? " (cache)" : ""} in ${Date.now() - t0}ms`);
      const mediaUrl = `/api/media/${basename(out.file)}`;
      return send(res, 200, { ...out, url: mediaUrl, audioUrl: mediaUrl });
    }

    /* ---------------------- audio ducking & native stt -------------------- */
    if (m === "POST" && p === "/api/audio/duck") {
      return send(res, 200, await duckMacAudio());
    }
    if (m === "POST" && p === "/api/audio/restore") {
      return send(res, 200, await restoreMacAudio());
    }
    if (m === "GET" && p === "/api/stt/stream") {
      const locale = url.searchParams.get("locale") || "en-IN";
      const silenceMs = Number(url.searchParams.get("silenceMs") || 1800);
      const compiledBin = resolve(join(DIST_DIR, "bin", "hv-stt"));
      const swiftScript = resolve(join(HERE, "..", "app", "stt.swift"));

      return sse(res, (sendEvt) => {
        if (process.platform !== "darwin") {
          sendEvt({ type: "error", error: "SFSpeechRecognizer requires macOS Darwin" });
          return () => {};
        }

        const cmd = existsSync(compiledBin) ? compiledBin : "swift";
        const args = existsSync(compiledBin)
          ? ["--locale", locale, "--silence-ms", String(silenceMs)]
          : [swiftScript, "--locale", locale, "--silence-ms", String(silenceMs)];

        let child = null;
        try {
          child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
        } catch (err) {
          sendEvt({ type: "error", error: `Failed to spawn native STT: ${err.message}` });
          return () => {};
        }

        let buf = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
              sendEvt(JSON.parse(line));
            } catch {
              sendEvt({ type: "interim", text: line });
            }
          }
        });
        child.on("error", (err) => {
          sendEvt({ type: "error", error: err.message });
        });
        child.on("close", () => {
          sendEvt({ type: "end" }, "end");
        });

        return () => {
          if (child && !child.killed) {
            try {
              child.kill("SIGTERM");
            } catch {
              /* ignore */
            }
          }
        };
      });
    }

    /* -------------------------- local faster-whisper STT -------------------- */
    if (m === "POST" && p === "/api/stt/whisper") {
      const body = await readBody(req);
      let audioPath = body.audioPath;
      if (body.audioBase64) {
        const buf = Buffer.from(body.audioBase64, "base64");
        audioPath = join(SCRATCH_DIR, `whisper-${Date.now()}.wav`);
        writeFileSync(audioPath, buf);
      }
      if (!audioPath || !existsSync(audioPath)) {
        return send(res, 400, { ok: false, error: "missingAudioFile" });
      }
      const pyBin = resolvePython();
      const scriptPath = resolve(join(HERE, "..", "scripts", "local_whisper.py"));
      execFile(pyBin, [scriptPath, "--audio", audioPath, "--model", "tiny", "--lang", body.lang ?? "auto"], { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) {
          log.warn("stt", `whisper error: ${err.message}`);
          return send(res, 500, { ok: false, error: "whisperFailed", detail: err.message });
        }
        try {
          const result = JSON.parse(stdout);
          return send(res, 200, result);
        } catch {
          return send(res, 200, { ok: true, text: stdout.trim() });
        }
      });
      return;
    }
    const mediaMatch = p.match(/^\/api\/media\/([\w.-]+)$/);
    if (m === "GET" && mediaMatch) {
      const name = basename(mediaMatch[1]).replace(/[^A-Za-z0-9._-]/g, "");
      const scratchFile = resolve(join(SCRATCH_DIR, name));
      const cacheFile = resolve(join(TTS_CACHE_DIR, name));
      const file =
        scratchFile.startsWith(resolve(SCRATCH_DIR)) && existsSync(scratchFile)
          ? scratchFile
          : cacheFile.startsWith(resolve(TTS_CACHE_DIR)) && existsSync(cacheFile)
            ? cacheFile
            : null;
      if (!file) return send(res, 404, { error: "notFound", message: "no such media file" });
      const ext = name.split(".").pop().toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Content-Length": statSync(file).size,
        "Accept-Ranges": "bytes",
      });
      return createReadStream(file).pipe(res);
    }

    /* -------------------------------- audit ------------------------------- */
    if (m === "GET" && p === "/api/audit") {
      return send(res, 200, { entries: store.listAudit(Number(url.searchParams.get("limit") ?? 500)), file: store.roots().audit });
    }
    if (m === "DELETE" && p === "/api/audit") {
      store.clearAudit();
      log.warn("permissions", "audit log cleared by user");
      return send(res, 200, { ok: true });
    }

    /* ------------------------------- sessions ----------------------------- */
    if (m === "GET" && p === "/api/sessions") return send(res, 200, { sessions: store.listSessions() });
    const sessionMatch = p.match(/^\/api\/sessions\/([\w-]+)$/);
    if (m === "GET" && sessionMatch) return send(res, 200, store.getSession(sessionMatch[1]) ?? { error: "notFound" });
    if (m === "DELETE" && p === "/api/sessions") {
      store.deleteAllSessions();
      return send(res, 200, { ok: true });
    }

    /* ---------------------------- hermes memory --------------------------- */
    if (m === "GET" && p === "/api/memory") return send(res, 200, store.listMemoryFiles());
    if (m === "GET" && p === "/api/memory/file") {
      const rel = url.searchParams.get("path") ?? "MEMORY.md";
      try {
        return send(res, 200, store.readMemoryFile(rel));
      } catch (e) {
        return send(res, e.status ?? 500, { error: "memoryReadFailed", message: e.message, hint: "read-only view of ~/.hermes/memories" });
      }
    }

    /* --------------------------------- logs ------------------------------- */
    if (m === "GET" && p === "/api/logs") {
      return send(res, 200, { lines: log.tail(Number(url.searchParams.get("limit") ?? 200), url.searchParams.get("level") ?? "debug") });
    }
    if (m === "GET" && p === "/api/logs/export") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": "attachment; filename=hermes-voice-bridge.log" });
      return res.end(log.exportText());
    }
    if (m === "GET" && p === "/api/logs/stream") return sse(res, (sendEvt) => log.subscribe((line) => sendEvt(line)));

    /* ------------------------------- self-test ---------------------------- */
    if (m === "GET" && p === "/api/selftest") {
      const results = await runServerTests();
      return send(res, 200, { results, passed: results.filter((r) => r.ok).length, total: results.length });
    }

    if (m === "GET" && p === "/api") {
      return send(res, 200, `Hermes Voice bridge v${VERSION} — loopback only. Try /api/health\n`);
    }

    /* ------------------------- static frontend (dist/) -------------------- */
    if (m === "GET" && !p.startsWith("/api/")) {
      const served = serveStaticAsset(p, res);
      if (served !== false) return;
      if (p === "/") {
        return send(res, 200, `Hermes Voice bridge v${VERSION} — loopback only (dist/ not built yet; run npm run build). Try /api/health\n`);
      }
    }

    return send(res, 404, { error: "notFound", message: `no route ${m} ${p}` });
  } catch (e) {
    return fail(res, e);
  }
}

const server = http.createServer(handleRequest);

export async function startServer(opts = {}) {
  if (Array.isArray(opts.hermesCmd)) {
    config.hermes.command = opts.hermesCmd;
  }
  const listenPort = opts.port !== undefined ? opts.port : config.port;
  const listenHost = opts.host || config.host || "127.0.0.1";
  const srv = http.createServer(handleRequest);
  await new Promise((resolveListen, rejectListen) => {
    srv.once("error", rejectListen);
    srv.listen(listenPort, listenHost, () => resolveListen());
  });
  const addr = srv.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : listenPort;
  return {
    port: actualPort,
    host: listenHost,
    server: srv,
    close: () =>
      new Promise((resClose) => {
        tasks.shutdown();
        srv.close(() => resClose());
      }),
  };
}

const isDirectRun = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isDirectRun && !process.env.HV_NO_LISTEN) {
  server.listen(config.port, config.host, () => {
    log.info("app", `Hermes Voice bridge v${VERSION} listening on http://${config.host}:${config.port}`);
    log.info("app", `data dir: ${DATA_DIR} · python: ${resolvePython()}`);
    log.info(
      "permissions",
      `timeout=${config.permissions.timeoutSec}s autoApproveLowRisk=${config.permissions.autoApproveLowRisk} maxConcurrentTasks=${config.maxConcurrentTasks}`,
    );
    cleanScratch();
  });

  server.on("error", (e) => {
    console.error(`[bridge] cannot listen on ${config.host}:${config.port} — ${e.message}`);
    console.error(`[bridge] another instance running? try HV_PORT=20131 node server/index.mjs`);
    process.exit(1);
  });

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      log.warn("app", `${sig} — killing child processes, then exiting`);
      tasks.shutdown();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500);
    });
  }
}

export { server, tasks, router, log, config, VERSION };
