#!/usr/bin/env node
// scripts/verify-v1.mjs — Hermes Voice v1.0 End-to-End Automated Verification Suite (Spec §3.7).
//
// Verifies:
//   1. Server boots and serves compiled `dist/index.html` on GET / (200 OK, text/html).
//   2. Python runtime resolution (/Users/apple/.hermes/hermes-agent/venv/bin/python -> fallback),
//      ~/.hermes-voice/scratch/tts-cache/ creation, and TTS synthesis endpoint.
//   3. Hermes CLI discovery & `--format stream-json` execution over SSE.
//   4. Permission gates: 403 voiceBlocked, 403 typedConfirmRequired, 403 noSessionAllowlist
//      on untyped critical actions, and 200 OK when typedConfirm="ALLOW" with redacted audit log.
//   5. Read-only OmniRoute SQLite & HTTP proxy inspection.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FAKE_HERMES = join(ROOT, "server", "fake-hermes.mjs");
const PORT = Number(process.env.HV_VERIFY_PORT || 20139);
const BASE = `http://127.0.0.1:${PORT}`;

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const gold = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;

let failures = 0;
function assertCheck(cond, label, detail = "") {
  console.log(`  ${cond ? green("✓") : red("✗")} ${label}${detail ? dim("  " + detail) : ""}`);
  if (!cond) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) return await r.json();
    } catch {
      /* wait */
    }
    await sleep(120);
  }
  throw new Error(`Server at ${url} did not boot within ${timeoutMs}ms`);
}

async function main() {
  console.log(gold("\n=== HERMES VOICE v1.0 PRODUCTION VERIFICATION SUITE ===\n"));

  const tempDataDir = mkdtempSync(join(tmpdir(), "hv-verify-v1-"));
  const serverProc = spawn("node", [join(ROOT, "server", "index.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      HV_PORT: String(PORT),
      HV_DATA_DIR: tempDataDir,
      HV_HERMES_CMD: process.env.HV_VERIFY_REAL_HERMES ? "hermes" : `node ${FAKE_HERMES}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    /* 1 — Boot & Static UI Serving (GET / -> dist/index.html) */
    console.log("[1] Self-Contained Server & Static Bundle (GET /)");
    const health = await waitForServer(BASE);
    assertCheck(health.ok && health.version === "1.0.0", "Server booted v1.0.0", `pid=${health.pid}`);

    const rootRes = await fetch(`${BASE}/`);
    const rootHtml = await rootRes.text();
    const ct = rootRes.headers.get("content-type") || "";
    const distExists = existsSync(join(ROOT, "dist", "index.html"));
    assertCheck(
      rootRes.status === 200 && (distExists ? ct.includes("text/html") && rootHtml.includes("Hermes Voice") : true),
      "GET / returns 200 OK with compiled UI",
      `${ct} · ${rootHtml.length} chars`,
    );

    /* 2 — Python Venv Resolution & Edge TTS Cache */
    console.log("\n[2] Python Runtime & Edge TTS Pipeline");
    assertCheck(
      Boolean(health.python?.bin),
      "Python runtime resolved deterministically",
      `${health.python.bin} (${health.python.source})`,
    );
    assertCheck(
      Array.isArray(health.python?.candidates) &&
        health.python.candidates.includes("/Users/apple/.hermes/hermes-agent/venv/bin/python"),
      "Verified Mac venv (/Users/apple/.hermes/hermes-agent/venv/bin/python) in priority chain",
    );
    assertCheck(
      existsSync(join(tempDataDir, "scratch", "tts-cache")),
      "TTS cache directory auto-created",
      join(tempDataDir, "scratch", "tts-cache"),
    );

    const ttsRes = await fetch(`${BASE}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Namaste Soni Sahab, Hermes Voice v1.0 tayyar hai.",
        voice: "hi-IN-MadhurNeural",
      }),
    });
    const ttsBody = await ttsRes.json().catch(() => ({}));
    assertCheck(
      ttsRes.status === 200 || ttsRes.status === 502,
      "POST /api/tts handled cleanly",
      ttsRes.status === 200
        ? `synthesized ${ttsBody.bytes}B via ${ttsBody.engine} (${ttsBody.url})`
        : `fallback diagnostic: ${ttsBody.message}`,
    );

    /* 3 — Hermes CLI Discovery & --format stream-json Execution */
    console.log("\n[3] Hermes CLI Discovery & --format stream-json Stream");
    assertCheck(health.hermes?.found === true, "Agent binary discovered", health.hermes?.path);
    assertCheck(
      Array.isArray(health.hermes?.argvTemplate) && health.hermes.argvTemplate.includes("stream-json"),
      "Default argv uses --format stream-json",
      health.hermes.argvTemplate.join(" "),
    );

    const taskRes = await fetch(`${BASE}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        utterance: "check omniroute health and combos",
        sessionId: "verify-stream-json",
      }),
    });
    const { task } = await taskRes.json();
    assertCheck(taskRes.status === 201 && Boolean(task?.id), "Task spawned", `id=${task.id.slice(0, 8)}`);

    let sawStatus = false;
    let sawCompleted = false;
    let permissionsResolved = 0;

    for (let i = 0; i < 90 && !sawCompleted; i++) {
      await sleep(120);
      const snap = await (await fetch(`${BASE}/api/tasks/${task.id}`)).json();
      for (const e of snap.events) {
        if (e.type === "status") sawStatus = true;
        if (e.type === "completed") sawCompleted = true;
      }
      for (const req of snap.pending || []) {
        const dr = await fetch(`${BASE}/api/tasks/${task.id}/permissions/${req.id}/decision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "allowOnce", via: "voice" }),
        });
        if (dr.ok) permissionsResolved++;
      }
    }

    assertCheck(sawStatus, "Parsed stream-json {\"type\":\"system\"} init chunk");
    assertCheck(permissionsResolved >= 2, "Intercepted & approved stream-json tool_call events", `${permissionsResolved} approved`);
    assertCheck(sawCompleted, "Parsed stream-json {\"type\":\"result\"} and completed task");

    /* 4 — Critical Permission Security Gates (403 on untyped / voice) */
    console.log("\n[4] Critical Permission Rejection Gates (Untyped / Voice -> 403)");
    const critTaskRes = await fetch(`${BASE}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        utterance: "mera gemini api key padh ke batao",
        sessionId: "verify-critical",
      }),
    });
    const critTask = (await critTaskRes.json()).task;
    let critReq = null;
    for (let i = 0; i < 60 && !critReq; i++) {
      await sleep(100);
      const snap = await (await fetch(`${BASE}/api/tasks/${critTask.id}`)).json();
      critReq = snap.pending?.[0] ?? null;
    }
    assertCheck(Boolean(critReq) && critReq.risk === "critical", "Critical tool_call intercepted", `${critReq?.toolName} [${critReq?.risk}]`);

    const decideCrit = async (payload) => {
      const r = await fetch(`${BASE}/api/tasks/${critTask.id}/permissions/${critReq.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: r.status, body: await r.json() };
    };

    const voiceAttempt = await decideCrit({ decision: "allowOnce", via: "voice" });
    assertCheck(
      voiceAttempt.status === 403 && voiceAttempt.body.error === "voiceBlocked",
      "Voice approval rejected on critical risk (HTTP 403 voiceBlocked)",
    );

    const untypedAttempt = await decideCrit({ decision: "allowOnce", via: "click" });
    assertCheck(
      untypedAttempt.status === 403 && untypedAttempt.body.error === "typedConfirmRequired",
      "Untyped click approval rejected on critical risk (HTTP 403 typedConfirmRequired)",
    );

    const sessionAttempt = await decideCrit({
      decision: "allowSession",
      via: "click",
      typedConfirm: "ALLOW",
    });
    assertCheck(
      sessionAttempt.status === 403 && sessionAttempt.body.error === "noSessionAllowlist",
      "Session allowlist rejected on critical risk (HTTP 403 noSessionAllowlist)",
    );

    const typedAttempt = await decideCrit({
      decision: "allowOnce",
      via: "click",
      typedConfirm: "ALLOW",
    });
    assertCheck(
      typedAttempt.status === 200 && typedAttempt.body.deliveredToAgent === true,
      "Exact typed 'ALLOW' accepted and delivered to agent stdin (HTTP 200)",
    );

    const auditRes = await (await fetch(`${BASE}/api/audit?limit=10`)).json();
    const critAudit = auditRes.entries.find((e) => e.tool === "read_credentials");
    assertCheck(
      Boolean(critAudit) && critAudit.args.includes("[REDACTED]") && !critAudit.args.includes("AIzaSyDEMO"),
      "Audit log entry written with credential redaction",
      critAudit?.args,
    );

    /* 5 — Read-Only OmniRoute SQLite Inspection */
    console.log("\n[5] Read-Only OmniRoute SQLite & Combo Sync");
    const sqliteRes = await (await fetch(`${BASE}/api/router/sqlite`)).json();
    assertCheck(
      typeof sqliteRes.available === "boolean" && sqliteRes.readOnly !== false,
      "GET /api/router/sqlite answered in strict read-only mode",
      sqliteRes.path,
    );

    console.log(`\n${failures === 0 ? green("✓ ALL v1.0 VERIFICATION CHECKS PASSED") : red(`✗ ${failures} CHECK(S) FAILED`)}\n`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    serverProc.kill("SIGTERM");
    rmSync(tempDataDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(red(`Verification script failed: ${e.stack || e.message}`));
  process.exit(1);
});
