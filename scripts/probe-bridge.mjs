#!/usr/bin/env node
// scripts/probe-bridge.mjs — live end-to-end probe of the local bridge over real HTTP.
//
//   node server/index.mjs &            (terminal 1)
//   node scripts/probe-bridge.mjs      (terminal 2)
//
// It walks the whole AC-5 → AC-7 → AC-6 loop against the running bridge:
// create task → stream SSE → answer the permission prompts → completion → audit.
// Nothing here touches Omniroute state and nothing here writes to ~/.hermes.

const BASE = process.env.HV_BRIDGE ?? "http://127.0.0.1:20130";
const UTTERANCE = process.argv[2] ?? "check omniroute health and combos";

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;

let failures = 0;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? green("✓") : red("✗")} ${label}${extra ? dim("  " + extra) : ""}`);
  if (!ok) failures++;
};

async function jget(path) {
  const r = await fetch(BASE + path);
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function main() {
  console.log(`\nHermes Voice bridge probe → ${BASE}`);
  console.log(`utterance: "${UTTERANCE}"\n`);

  /* 1 — health */
  console.log("[1] GET /api/health");
  let health;
  try {
    const r = await jget("/api/health");
    health = r.body;
    check(r.status === 200 && health.ok, "bridge answers", `v${health.version} · node ${health.node} · pid ${health.pid}`);
    check(health.hermes.found === true, "agent binary resolved", health.hermes.found ? health.hermes.path : health.hermes.detail);
    console.log(dim(`    argv → ${(health.hermes.command ?? []).join(" ")} ${(health.hermes.argvTemplate ?? []).join(" ")}`));
    check(typeof health.omniroute.reachable === "boolean", "omniroute probed (never restarted)", `reachable=${health.omniroute.reachable} ${health.omniroute.baseURL}`);
    check(health.tts.engines.gemini.available === false, "gemini tts deliberately unwired", health.tts.engines.gemini.detail.slice(0, 48) + "…");
    console.log(dim(`    tts engines → edge=${health.tts.engines.edge.available} say=${health.tts.engines.say.available}`));
    check(health.tasks.cap === 10, "concurrency hard cap = 10", JSON.stringify(health.tasks));
    check(Boolean(health.protocol?.stdin?.["HV_DECISION:"]), "wire protocol self-documented");
  } catch (e) {
    check(false, "bridge reachable", `${e.message} — start it: node server/index.mjs`);
    process.exit(1);
  }

  /* 2 — create task */
  console.log("\n[2] POST /api/tasks");
  const created = await fetch(BASE + "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ utterance: UTTERANCE, sessionId: `probe-${Date.now()}` }),
  });
  const createdBody = await created.json();
  check(created.status === 201, "task accepted", `id=${createdBody.task?.id?.slice(0, 8)}`);
  const taskId = createdBody.task.id;

  /* 3 — stream events over SSE and answer permissions */
  console.log("\n[3] GET /api/tasks/:id/events (SSE) + permission round-trip");
  const sseRes = await fetch(`${BASE}/api/tasks/${taskId}/events`);
  check(sseRes.headers.get("content-type")?.includes("text/event-stream") === true, "SSE content-type", sseRes.headers.get("content-type"));

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const answered = [];
  let completed = null;
  let failed = null;
  const t0 = Date.now();

  while (Date.now() - t0 < 45000 && !completed && !failed) {
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
        const req = evt.payload.request;
        console.log(dim(`    ⏸  ${req.toolName} [${req.risk}] ${JSON.stringify(req.args).slice(0, 60)}`));
        // low/medium → allow once; high/critical → deny (probe stays safe by default)
        const decision = ["low", "medium"].includes(req.risk) ? "allowOnce" : "deny";
        const dr = await fetch(`${BASE}/api/tasks/${taskId}/permissions/${req.id}/decision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision, via: "click" }),
        });
        const db = await dr.json();
        answered.push({ tool: req.toolName, risk: req.risk, decision, status: dr.status, delivered: db.deliveredToAgent });
        console.log(dim(`    ▶  ${decision} → HTTP ${dr.status} deliveredToAgent=${db.deliveredToAgent}`));
      } else if (evt.type === "permissionDecision") {
        console.log(dim(`    ✓  decision recorded (${evt.payload.decision} via ${evt.payload.via})`));
      } else if (evt.type === "toolCall") {
        console.log(dim(`    ⚙  toolCall ${evt.payload.name}`));
      } else if (evt.type === "completed") {
        completed = evt.payload.text;
      } else if (evt.type === "failed") {
        failed = evt.payload;
      } else if (evt.type === "progress") {
        console.log(dim(`    ·  ${String(evt.payload.text).slice(0, 70)}`));
      }
    }
  }
  reader.cancel().catch(() => {});

  check(answered.length > 0, "permission requests intercepted mid-run", `${answered.length} answered`);
  check(answered.every((a) => a.delivered === true), "every decision reached the agent's stdin");
  check(answered.filter((a) => ["high", "critical"].includes(a.risk)).every((a) => a.decision === "deny"), "high/critical never auto-allowed by the probe");
  check(Boolean(completed), "task completed over the stream", completed ? `${completed.length} chars` : JSON.stringify(failed));
  if (completed) console.log(dim(`    ✦ ${completed.slice(0, 140)}${completed.length > 140 ? "…" : ""}`));

  /* 4 — persisted state */
  console.log("\n[4] GET /api/audit + /api/sessions");
  const audit = await jget("/api/audit?limit=10");
  check(audit.status === 200 && Array.isArray(audit.body.entries) && audit.body.entries.length >= answered.length, "audit rows written", `${audit.body.entries.length} rows in ${audit.body.file}`);
  const top = audit.body.entries[0];
  if (top) console.log(dim(`    ${top.tool} [${top.risk}] → ${top.decision} via ${top.via} | ${top.args}`));
  check(!/sk-[A-Za-z0-9]{8}|AIza[0-9A-Za-z]{10}/.test(JSON.stringify(audit.body)), "no plaintext secrets in the audit file");

  const sessions = await jget("/api/sessions");
  check(sessions.status === 200 && sessions.body.sessions.length > 0, "session persisted", `${sessions.body.sessions.length} sessions`);
  const s = sessions.body.sessions.find((x) => x.id === createdBody.task.sessionId);
  check(s?.utterances?.length === 2, "session has user + assistant turns", `${s?.utterances?.length ?? 0} turns`);

  /* 5 — memory is read-only and jailed */
  console.log("\n[5] GET /api/memory (read-only)");
  const mem = await jget("/api/memory");
  check(mem.status === 200, "memory listing answered", mem.body.available ? `${mem.body.files.length} files under ${mem.body.root}` : mem.body.note);
  const escape = await fetch(BASE + "/api/memory/file?path=" + encodeURIComponent("../../etc/passwd"));
  check(escape.status === 400, "path traversal rejected", `HTTP ${escape.status}`);

  /* 6 — router endpoints are read-only */
  console.log("\n[6] GET /api/router/*");
  const rh = await jget("/api/router/health");
  check(rh.status === 200 && typeof rh.body.reachable === "boolean", "router health proxied", `reachable=${rh.body.reachable} latency=${rh.body.latencyMs}ms`);
  const rc = await jget("/api/router/combos");
  check(rc.status === 200, "combos endpoint probed read-only", rc.body.pathUsed ?? rc.body.note);

  /* 7 — server-side test suite */
  console.log("\n[7] GET /api/selftest");
  const st = await jget("/api/selftest");
  check(st.status === 200 && st.body.passed === st.body.total, "bridge self-tests green", `${st.body.passed}/${st.body.total}`);
  for (const r of (st.body.results ?? []).filter((x) => !x.ok)) console.log(red(`    FAILED ${r.suite}: ${r.name}\n      ${r.detail}`));

  /* 8 — TTS */
  console.log("\n[8] POST /api/tts");
  const tts = await fetch(BASE + "/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Task ho gaya. Report overlay me hai." }) });
  const ttsBody = await tts.json().catch(() => ({}));
  check(tts.status === 200 || tts.status === 502, "tts answered with a definite result", tts.status === 200 ? `${ttsBody.engine} · ${ttsBody.bytes}B · ${ttsBody.ms}ms · ${ttsBody.url}` : `honest failure: ${ttsBody.message} (${ttsBody.hint})`);

  /* 9 — logs are redacted */
  console.log("\n[9] GET /api/logs");
  const logs = await jget("/api/logs?limit=300");
  check(logs.status === 200 && logs.body.lines.length > 0, "logs captured", `${logs.body.lines.length} lines`);
  check(!/sk-[A-Za-z0-9]{8}/.test(JSON.stringify(logs.body)), "no secrets in logs");

  console.log(`\n${failures === 0 ? green("ALL CHECKS PASSED") : red(failures + " CHECK(S) FAILED")}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(red("probe crashed: " + e.stack));
  process.exit(1);
});
