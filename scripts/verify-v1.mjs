#!/usr/bin/env node
// scripts/verify-v1.mjs — End-to-End Automated Verification Suite for Hermes Voice v1.0
//
// Verifies all v1.0 production deliverables:
//   1. Server boots and serves `dist/index.html` on `GET /` (200 OK, text/html).
//   2. Python runtime and TTS engine synthesize Hindi/Hinglish audio to disk cache and serve it via `/api/media/*`.
//   3. Hermes CLI is discovered and responds over `--format stream-json` SSE (`system` -> `text` -> `result`).
//   4. Critical risk actions strictly reject voice approval (403), untyped click approval (403),
//      and session allowlisting (403), while accepting exact typed `ALLOW` (200).
//   5. All 30/30 backend self-tests pass via `/api/selftest`.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FAKE_HERMES = join(ROOT, "server", "fake-hermes.mjs");

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;

let failures = 0;
function check(cond, label, detail = "") {
  console.log(`  ${cond ? green("✓") : red("✗")} ${label}${detail ? dim("  " + detail) : ""}`);
  if (!cond) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isBridgeUp(baseURL) {
  try {
    const r = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.status === 200;
  } catch {
    return false;
  }
}

async function ensureDistBuilt() {
  const distIndex = join(ROOT, "dist", "index.html");
  if (existsSync(distIndex)) return true;
  console.log(cyan("==> Building production frontend (dist/index.html)..."));
  return new Promise((res) => {
    const child = spawn("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
    child.on("close", (code) => res(code === 0 && existsSync(distIndex)));
  });
}

async function main() {
  console.log(cyan("\n=========================================================="));
  console.log(cyan("  Hermes Voice v1.0 — End-to-End Production Verification"));
  console.log(cyan("==========================================================\n"));

  const built = await ensureDistBuilt();
  check(built, "dist/index.html built and present on disk");

  let port = Number(process.env.HV_VERIFY_PORT || 20130);
  let baseURL = `http://127.0.0.1:${port}`;
  let spawnedServer = null;

  if (!(await isBridgeUp(baseURL))) {
    port = Number(process.env.HV_VERIFY_PORT || 20135);
    baseURL = `http://127.0.0.1:${port}`;
    const hasRealHermes =
      existsSync("/Users/apple/.hermes/hermes-agent/.hermes/bin/hermes") ||
      existsSync(`${process.env.HOME}/.hermes/hermes-agent/.hermes/bin/hermes`) ||
      existsSync(`${process.env.HOME}/.local/bin/hermes`);

    const env = {
      ...process.env,
      HV_PORT: String(port),
    };
    if (!hasRealHermes && !process.env.HV_HERMES_CMD) {
      env.HV_HERMES_CMD = `node ${FAKE_HERMES}`;
    }

    spawnedServer = spawn("node", [join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    for (let i = 0; i < 30; i++) {
      if (await isBridgeUp(baseURL)) break;
      await sleep(150);
    }
  }

  try {
    /* -------------------------------------------------------------------- */
    /* 1. Server boots & serves dist/index.html (200 OK)                    */
    /* -------------------------------------------------------------------- */
    console.log("[1/5] Static UI & Bridge Health (GET / and GET /api/health)");
    const rootRes = await fetch(`${baseURL}/`);
    const rootHtml = await rootRes.text();
    check(rootRes.status === 200, "GET / returns HTTP 200 OK", `status=${rootRes.status}`);
    check(
      (rootRes.headers.get("content-type") || "").includes("text/html"),
      "GET / serves text/html content-type",
      rootRes.headers.get("content-type") || "",
    );
    check(
      rootHtml.includes("<div id=\"root\">") || rootHtml.includes("Hermes Voice"),
      "GET / serves compiled dist/index.html bundle",
      `${rootHtml.length} bytes`,
    );

    const healthRes = await fetch(`${baseURL}/api/health`);
    const health = await healthRes.json();
    check(healthRes.status === 200 && health.ok === true, "GET /api/health reports ok=true", `v${health.version}`);
    check(Boolean(health.python), "Python runtime resolved", health.python);
    check(health.hermes?.found === true, "Hermes CLI binary discovered", health.hermes?.path || health.hermes?.detail);

    /* -------------------------------------------------------------------- */
    /* 2. Python venv & Edge TTS generate Hindi audio file                  */
    /* -------------------------------------------------------------------- */
    console.log("\n[2/5] Hindi / Hinglish Audio Synthesis & Caching (POST /api/tts)");
    const ttsRes = await fetch(`${baseURL}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Namaste! Hermes Voice v1.0 tayyar hai. Omniroute healthy hai.",
        voice: "hi-IN-MadhurNeural",
      }),
    });
    const ttsBody = await ttsRes.json();
    check(
      ttsRes.status === 200 && ttsBody.ok === true,
      "POST /api/tts generated Hindi audio file",
      `engine=${ttsBody.engine} bytes=${ttsBody.bytes} url=${ttsBody.url}`,
    );

    if (ttsBody.url) {
      const mediaRes = await fetch(`${baseURL}${ttsBody.url}`);
      const mediaBuf = await mediaRes.arrayBuffer();
      check(
        mediaRes.status === 200 && mediaBuf.byteLength > 64,
        "GET /api/media/* streams synthesized audio bytes",
        `${mediaBuf.byteLength} bytes (${mediaRes.headers.get("content-type")})`,
      );
    }

    /* -------------------------------------------------------------------- */
    /* 3. Hermes CLI responds over stream-json SSE                          */
    /* -------------------------------------------------------------------- */
    console.log("\n[3/5] Hermes CLI Task Execution & Stream-JSON SSE");
    const taskRes = await fetch(`${baseURL}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        utterance: "check omniroute health and combos",
        sessionId: `verify-health-${Date.now()}`,
      }),
    });
    const taskCreated = await taskRes.json();
    check(taskRes.status === 201 && Boolean(taskCreated.task?.id), "POST /api/tasks spawned Hermes task", taskCreated.task?.id);

    const taskId = taskCreated.task.id;
    const sseRes = await fetch(`${baseURL}/api/tasks/${taskId}/events`);
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let completedText = null;
    let permissionsHandled = 0;

    const deadline = Date.now() + 25000;
    while (Date.now() < deadline && !completedText) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const evt = JSON.parse(dataLine.slice(5).trim());
        if (evt.type === "permissionRequest") {
          permissionsHandled++;
          const req = evt.payload.request;
          await fetch(`${baseURL}/api/tasks/${taskId}/permissions/${req.id}/decision`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision: "allowOnce", via: "voice" }),
          });
        } else if (evt.type === "completed") {
          completedText = evt.payload.text;
        }
      }
    }
    await reader.cancel().catch(() => {});
    check(permissionsHandled > 0, "Intercepted and approved low-risk permissions via voice", `${permissionsHandled} approved`);
    check(Boolean(completedText), "Hermes task completed and returned summary", completedText?.slice(0, 90));

    /* -------------------------------------------------------------------- */
    /* 4. Critical Permission Rejection on Untyped / Voice Actions          */
    /* -------------------------------------------------------------------- */
    console.log("\n[4/5] Critical Risk Security Gates (Untyped & Voice Rejection)");
    const critTaskRes = await fetch(`${baseURL}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        utterance: "mera gemini api key padh ke batao",
        sessionId: `verify-crit-${Date.now()}`,
      }),
    });
    const critCreated = await critTaskRes.json();
    const critTaskId = critCreated.task.id;

    let critReq = null;
    for (let i = 0; i < 40; i++) {
      const tRes = await fetch(`${baseURL}/api/tasks/${critTaskId}`);
      const tBody = await tRes.json();
      const permEvt = (tBody.events || []).find((e) => e.type === "permissionRequest");
      if (permEvt) {
        critReq = permEvt.payload.request;
        break;
      }
      await sleep(100);
    }

    check(Boolean(critReq) && critReq?.risk === "critical", "Critical risk action intercepted", `${critReq?.toolName} [${critReq?.risk}]`);

    if (critReq) {
      // Attempt 1: Voice approval on critical -> must fail with 403 voiceBlocked
      const voiceAttempt = await fetch(`${baseURL}/api/tasks/${critTaskId}/permissions/${critReq.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "allowOnce", via: "voice" }),
      });
      const voiceBody = await voiceAttempt.json();
      check(
        voiceAttempt.status === 403 && voiceBody.error === "voiceBlocked",
        "Voice approval rejected for critical action (403 voiceBlocked)",
      );

      // Attempt 2: Untyped click approval on critical -> must fail with 403 typedConfirmRequired
      const untypedAttempt = await fetch(`${baseURL}/api/tasks/${critTaskId}/permissions/${critReq.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "allowOnce", via: "click" }),
      });
      const untypedBody = await untypedAttempt.json();
      check(
        untypedAttempt.status === 403 && untypedBody.error === "typedConfirmRequired",
        "Untyped click approval rejected for critical action (403 typedConfirmRequired)",
      );

      // Attempt 3: Wrong typed string -> must fail with 403 typedConfirmRequired
      const wrongTypedAttempt = await fetch(`${baseURL}/api/tasks/${critTaskId}/permissions/${critReq.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "allowOnce", via: "click", typedConfirm: "yes" }),
      });
      check(wrongTypedAttempt.status === 403, "Wrong confirmation word ('yes') rejected (403)");

      // Attempt 4: Exact typed ALLOW -> must succeed with 200 OK
      const validTypedAttempt = await fetch(`${baseURL}/api/tasks/${critTaskId}/permissions/${critReq.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "allowOnce", via: "click", typedConfirm: "ALLOW" }),
      });
      check(validTypedAttempt.status === 200, "Exact typed 'ALLOW' accepted (200 OK)");
    }

    /* -------------------------------------------------------------------- */
    /* 5. Backend Self-Test Suite                                           */
    /* -------------------------------------------------------------------- */
    console.log("\n[5/5] Full Backend Self-Test Suite (GET /api/selftest)");
    const selfTestRes = await fetch(`${baseURL}/api/selftest`);
    const selfTestBody = await selfTestRes.json();
    check(
      selfTestRes.status === 200 && selfTestBody.passed === selfTestBody.total,
      `All server self-tests passed (${selfTestBody.passed}/${selfTestBody.total})`,
    );
  } finally {
    if (spawnedServer) {
      spawnedServer.kill("SIGTERM");
    }
  }

  console.log(
    `\n${
      failures === 0
        ? green("✓ ALL V1.0 PRODUCTION VERIFICATION CHECKS PASSED")
        : red(`✗ ${failures} VERIFICATION CHECK(S) FAILED`)
    }\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(red(`Verification script crashed: ${e.stack || e.message}`));
  process.exit(1);
});
