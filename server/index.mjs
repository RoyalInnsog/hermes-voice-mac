// server/index.mjs — Hermes Voice v1.0 Self-Contained HTTP/SSE Bridge & Static Server (Spec §2.1).
//
//   node server/index.mjs          → http://127.0.0.1:20130
//
// Single-port production server:
//   • Serves the compiled Vite production UI (`dist/index.html` & static assets) on GET /
//   • Spawns Hermes CLI (`hermes chat -q "<utterance>" --format stream-json`)
//   • Streams SSE events and relays permission decisions to child stdin
//   • Synthesizes speech via Edge TTS (/Users/apple/.hermes/hermes-agent/venv/bin/python) + macOS `say` fallback
//   • Proxies OmniRoute read-only + inspects ~/.9router/db/data.sqlite strictly read-only

import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { basename, extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDirs, loadConfig, saveConfig, SCRATCH_DIR, TTS_CACHE_DIR, DATA_DIR } from "./config.mjs";
import { Logger } from "./logger.mjs";
import { OmnirouteClient } from "./omniroute.mjs";
import { TaskManager, TaskError } from "./agent.mjs";
import { detectEngines, synthesize } from "./tts.mjs";
import * as store from "./store.mjs";
import { cleanScratch } from "./store.mjs";
import { EVENT_KINDS, MARKERS } from "./protocol.mjs";
import { runServerTests } from "./selftest.mjs";

const VERSION = "1.0.0";
const startedAt = Date.now();
const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(HERE, "..", "dist");

ensureDirs();
const config = loadConfig();
const log = new Logger({ level: config.logging.level, redactEnabled: config.logging.redact });
const router = new OmnirouteClient(config.omniroute.baseURL, log, config.omniroute.sqlitePath);
const tasks = new TaskManager({ config, log });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".aiff": "audio/aiff",
  ".txt": "text/plain; charset=utf-8",
};

/* ------------------------------- helpers -------------------------------- */

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type":
      typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers,
  });
  res.end(payload);
}

function fail(res, err) {
  if (err instanceof TaskError) {
    return send(res, err.status, { error: err.code, message: err.message, hint: err.hint });
  }
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
  !addr ||
  addr === "127.0.0.1" ||
  addr === "::1" ||
  addr === "::ffff:127.0.0.1" ||
  addr.startsWith("::ffff:127.");

function cors(req, res) {
  const origin = req.headers.origin;
  const allowed =
    origin &&
    (config.allowedOrigins.includes(origin) ||
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
      origin === "null"); // WKWebView local file/app origin
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function sse(res, onReady) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");
  const pushEvt = (data, event) => {
    try {
      if (event) res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      return false;
    }
  };
  const cleanup = onReady(pushEvt);
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

function serveStaticFile(res, filePath) {
  const ext = extname(filePath).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";
  const st = statSync(filePath);
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": st.size,
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
  });
  createReadStream(filePath).pipe(res);
}

/* --------------------------------- routes -------------------------------- */

const PROTOCOL_DOC = {
  streamJson: {
    command: 'hermes chat -q "<utterance>" --format stream-json',
    events: [
      '{"type": "system", "subtype": "init", "model": "...", "session_id": "..."}',
      '{"type": "text", "text": "..."}',
      '{"type": "tool_call", "name": "...", "arguments": {...}}',
      '{"type": "result", "text": "...", "exit_code": 0}',
    ],
  },
  stdout: {
    [MARKERS.event]: `{ kind: one of ${JSON.stringify(EVENT_KINDS)}, ...payload }`,
    [MARKERS.perm]: "{ tool, args{}, reason?, risk? (computed if absent), id? }",
    [MARKERS.progress]: "<free text>",
    "unmarked line": "treated as plain assistant text; whole stdout becomes the answer if no result/completed arrives",
  },
  stdin: { [MARKERS.decision]: "{ id, decision: allowOnce|allowSession|deny }" },
};

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (!isLoopback(req.socket.remoteAddress)) {
    log.warn("app", `rejected non-loopback peer ${req.socket.remoteAddress}`);
    return send(res, 403, {
      error: "loopbackOnly",
      message: "this bridge only accepts connections from 127.0.0.1",
    });
  }

  const url = new URL(req.url, `http://${config.host}:${config.port}`);
  const p = url.pathname;
  const m = req.method;

  try {
    /* ---------------------------- bridge health --------------------------- */
    if (m === "GET" && p === "/api/health") {
      const [hermes, ttsEngines, omni, sqliteInfo] = await Promise.all([
        tasks.resolveBinary(),
        detectEngines(null),
        router.health(),
        router.inspectSqliteReadOnly(),
      ]);
      const activeCombo =
        sqliteInfo.combos?.[0]?.name || config.omniroute.activeComboHint || "KRITI";
      return send(res, 200, {
        ok: true,
        service: "hermes-voice-bridge",
        version: VERSION,
        node: process.version,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        pid: process.pid,
        dataDir: DATA_DIR,
        staticBundleReady: existsSync(join(DIST_DIR, "index.html")),
        python: config.python,
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
          activeCombo,
          sqlite: {
            available: sqliteInfo.available,
            path: sqliteInfo.path,
            combosCount: sqliteInfo.combos.length,
            providersCount: sqliteInfo.providers.length,
          },
        },
        tts: { engines: ttsEngines, configured: config.tts },
        tasks: tasks.stats(),
        permissions: config.permissions,
        logging: config.logging,
        protocol: PROTOCOL_DOC,
      });
    }

    if (m === "GET" && p === "/api/protocol") return send(res, 200, PROTOCOL_DOC);

    /* ------------------------------- config ------------------------------- */
    if (m === "GET" && p === "/api/config") {
      return send(res, 200, { config, file: `${DATA_DIR}/config.json` });
    }
    if (m === "PATCH" && p === "/api/config") {
      const patch = await readBody(req);
      const allowed = {
        hermes: ["command", "argvTemplate", "cwd", "timeoutSec"],
        omniroute: ["baseURL", "probeModel", "activeComboHint"],
        tts: ["engine", "voice", "englishVoice", "rate", "cacheEnabled"],
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
        return send(res, 502, {
          error: "omnirouteModelsFailed",
          message: e.message,
          hint: `curl -sS ${config.omniroute.baseURL}/v1/models`,
        });
      }
    }
    if (m === "GET" && p === "/api/router/combos") {
      const r = await router.combos();
      return send(res, 200, {
        ...r,
        note: r.pathUsed ? `read-only (${r.source})` : "no combo source reachable",
      });
    }
    if (m === "GET" && p === "/api/router/sqlite") {
      return send(res, 200, await router.inspectSqliteReadOnly());
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
      const task = await tasks.start({
        utterance: body.utterance,
        sessionId: body.sessionId,
        meta: body.meta,
      });
      log.info("agent", `task created ${task.id} for session ${task.sessionId}`);
      return send(res, 201, { task, eventsUrl: `/api/tasks/${task.id}/events` });
    }
    if (m === "GET" && p === "/api/tasks") {
      return send(res, 200, { tasks: tasks.list(), stats: tasks.stats() });
    }

    const taskMatch = p.match(/^\/api\/tasks\/([\w-]+)$/);
    if (m === "GET" && taskMatch) return send(res, 200, tasks.get(taskMatch[1]));
    if (m === "DELETE" && taskMatch) return send(res, 200, tasks.cancel(taskMatch[1]));

    const eventsMatch = p.match(/^\/api\/tasks\/([\w-]+)\/events$/);
    if (m === "GET" && eventsMatch) {
      const id = eventsMatch[1];
      const after = Number(url.searchParams.get("after") ?? 0);
      return sse(res, (pushEvt) => {
        for (const e of tasks.eventsSince(id, after)) pushEvt(e);
        const unsub = tasks.subscribe(id, (e) => pushEvt(e));
        const task = tasks.get(id);
        if (["done", "failed", "cancelled"].includes(task.status)) {
          pushEvt({ type: "end", taskId: id }, "end");
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
      return send(res, 200, { engines: await detectEngines(log), configured: config.tts });
    }
    if (m === "POST" && p === "/api/tts") {
      const body = await readBody(req);
      const engine = body.engine ?? (config.tts.engine === "gemini" ? "auto" : config.tts.engine);
      const t0 = Date.now();
      const out = await synthesize(
        {
          text: body.text,
          voice: body.voice ?? config.tts.voice,
          rate: body.rate ?? config.tts.rate,
          engine,
          cacheDir: TTS_CACHE_DIR,
        },
        log,
      );
      if (!out.ok) {
        return send(res, 502, {
          ok: false,
          error: "ttsFailed",
          message: out.error,
          hint: out.hint ?? "Verify /Users/apple/.hermes/hermes-agent/venv/bin/python -m pip install edge-tts",
        });
      }
      log.info(
        "tts",
        `synthesised ${out.bytes}B via ${out.engine}${out.cached ? " (cache hit)" : ""} in ${Date.now() - t0}ms`,
      );
      return send(res, 200, { ...out, url: `/api/media/${basename(out.file)}` });
    }

    const mediaMatch = p.match(/^\/api\/media\/([\w.-]+)$/);
    if (m === "GET" && mediaMatch) {
      const name = basename(mediaMatch[1]).replace(/[^A-Za-z0-9._-]/g, "");
      const candidateCache = resolve(join(TTS_CACHE_DIR, name));
      const candidateScratch = resolve(join(SCRATCH_DIR, name));
      const file =
        candidateCache.startsWith(resolve(TTS_CACHE_DIR)) && existsSync(candidateCache)
          ? candidateCache
          : candidateScratch.startsWith(resolve(SCRATCH_DIR)) && existsSync(candidateScratch)
            ? candidateScratch
            : null;
      if (!file) return send(res, 404, { error: "notFound", message: "no such media file" });
      return serveStaticFile(res, file);
    }

    /* -------------------------------- audit ------------------------------- */
    if (m === "GET" && p === "/api/audit") {
      return send(res, 200, {
        entries: store.listAudit(Number(url.searchParams.get("limit") ?? 500)),
        file: store.roots().audit,
      });
    }
    if (m === "DELETE" && p === "/api/audit") {
      store.clearAudit();
      log.warn("permissions", "audit log cleared by user");
      return send(res, 200, { ok: true });
    }

    /* ------------------------------- sessions ----------------------------- */
    if (m === "GET" && p === "/api/sessions") {
      return send(res, 200, { sessions: store.listSessions() });
    }
    const sessionMatch = p.match(/^\/api\/sessions\/([\w-]+)$/);
    if (m === "GET" && sessionMatch) {
      return send(res, 200, store.getSession(sessionMatch[1]) ?? { error: "notFound" });
    }
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
        return send(res, e.status ?? 500, {
          error: "memoryReadFailed",
          message: e.message,
          hint: "read-only view of ~/.hermes/memories",
        });
      }
    }

    /* --------------------------------- logs ------------------------------- */
    if (m === "GET" && p === "/api/logs") {
      return send(res, 200, {
        lines: log.tail(
          Number(url.searchParams.get("limit") ?? 200),
          url.searchParams.get("level") ?? "debug",
        ),
      });
    }
    if (m === "GET" && p === "/api/logs/export") {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": "attachment; filename=hermes-voice-bridge.log",
      });
      return res.end(log.exportText());
    }
    if (m === "GET" && p === "/api/logs/stream") {
      return sse(res, (pushEvt) => log.subscribe((line) => pushEvt(line)));
    }

    /* ------------------------------- self-test ---------------------------- */
    if (m === "GET" && p === "/api/selftest") {
      const results = await runServerTests();
      return send(res, 200, {
        results,
        passed: results.filter((r) => r.ok).length,
        total: results.length,
      });
    }

    if (m === "GET" && p === "/api") {
      return send(res, 200, `Hermes Voice bridge v${VERSION} — loopback only. Try /api/health\n`);
    }

    /* ------------------ static UI serving from dist/ (§2.1) ---------------- */
    if (m === "GET" && !p.startsWith("/api/")) {
      const relPath = p === "/" ? "index.html" : p.replace(/^\/+/, "");
      const candidate = resolve(DIST_DIR, relPath);
      if (candidate.startsWith(DIST_DIR) && existsSync(candidate) && statSync(candidate).isFile()) {
        return serveStaticFile(res, candidate);
      }
      const fallbackHtml = join(DIST_DIR, "index.html");
      if (existsSync(fallbackHtml)) {
        return serveStaticFile(res, fallbackHtml);
      }
      return send(
        res,
        200,
        `Hermes Voice bridge v${VERSION} is running on http://${config.host}:${config.port} (run \`npm run build\` to generate dist/index.html).\n`,
      );
    }

    return send(res, 404, { error: "notFound", message: `no route ${m} ${p}` });
  } catch (e) {
    return fail(res, e);
  }
});

server.listen(config.port, config.host, () => {
  log.info("app", `Hermes Voice v${VERSION} listening on http://${config.host}:${config.port}`);
  log.info("app", `python runtime: ${config.python.bin} (${config.python.source})`);
  log.info("app", `data dir: ${DATA_DIR} | tts cache: ${TTS_CACHE_DIR}`);
  cleanScratch();
});

server.on("error", (e) => {
  console.error(`[bridge] cannot listen on ${config.host}:${config.port} — ${e.message}`);
  console.error(`[bridge] another instance running? try HV_PORT=20131 node server/index.mjs`);
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log.warn("app", `${sig} — terminating child process groups, then exiting`);
    tasks.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}

export { server, tasks, router, log, config };
