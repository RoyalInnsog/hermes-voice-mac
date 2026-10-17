// server/selftest.mjs — backend test suite (spec §15, v1.0).
// Run standalone:  node server/selftest.mjs
// Run live over HTTP:  curl -s http://127.0.0.1:20130/api/selftest
//
// Includes REAL integration tests: TaskManager spawns server/fake-hermes.mjs
// in both HV_* and `--format stream-json` modes, streams events, pauses on tool
// permissions, receives HV_DECISION on stdin, and resumes.

import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDirs, resolvePython, TTS_CACHE_DIR } from "./config.mjs";
import { buildArgv, encodeDecision, lineSplitter, parseLine, MARKERS } from "./protocol.mjs";
import { redact, redactArgs, REDACTED } from "./redact.mjs";
import { allowsVoiceApproval, canAutoApprove, classifyRisk, requiresTypedConfirm } from "./risk.mjs";
import { mapVoiceDecision, speechify, summarizeForSpeech } from "./speechPrep.mjs";
import { OmnirouteClient } from "./omniroute.mjs";
import * as store from "./store.mjs";
import { TaskManager } from "./agent.mjs";
import { detectEngines } from "./tts.mjs";
import { Logger } from "./logger.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fake-hermes.mjs");

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class T {
  constructor(logs) {
    this.logs = logs;
  }
  true(cond, msg) {
    if (!cond) throw new Error("expected true: " + msg);
    this.logs.push("✓ " + msg);
  }
  eq(a, b, msg) {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
    this.logs.push("✓ " + msg);
  }
  has(hay, needle, msg) {
    if (!String(hay).includes(needle)) throw new Error(`${msg} — ${JSON.stringify(hay)} missing ${JSON.stringify(needle)}`);
    this.logs.push("✓ " + msg);
  }
  hasNot(hay, needle, msg) {
    if (String(hay).includes(needle)) throw new Error(`${msg} — must not contain ${JSON.stringify(needle)}`);
    this.logs.push("✓ " + msg);
  }
  throws(fn, code, msg) {
    try {
      fn();
    } catch (e) {
      if (code && e.code !== code) throw new Error(`${msg} — wrong code ${e.code}, want ${code}`);
      this.logs.push("✓ " + msg);
      return e;
    }
    throw new Error(msg + " — did not throw");
  }
  async throwsAsync(promise, code, msg) {
    try {
      await promise;
    } catch (e) {
      if (code && e.code !== code) throw new Error(`${msg} — wrong code ${e.code}, want ${code}`);
      this.logs.push("✓ " + msg);
      return e;
    }
    throw new Error(msg + " — did not throw");
  }
}

const suites = [];
const test = (suite, name, fn) => suites.push({ suite, name, fn });

/* ------------------------------- protocol -------------------------------- */

test("protocol", "HV_EVENT lines parse into typed events", (t) => {
  const p = parseLine('HV_EVENT: {"kind":"completed","text":"done"}', "task1");
  t.eq(p.type, "event", "typed as event");
  t.eq(p.event.kind, "completed", "kind preserved");
  t.eq(p.event.text, "done", "payload preserved");
});

test("protocol", "HV_PERM lines build a request and compute risk when absent", (t) => {
  const p = parseLine('HV_PERM: {"tool":"shell","args":{"cmd":"rm -rf /tmp/x"}}', "t1");
  t.eq(p.type, "permission", "typed as permission");
  t.eq(p.request.risk, "critical", "dangerous arg escalated to critical");
  t.eq(p.request.taskID, "t1", "task attached");
});

test("protocol", "stream-json lines parse system, text, tool_call, and result", (t) => {
  const sys = parseLine('{"type":"system","subtype":"init","model":"KRITI","session_id":"s1"}', "t1");
  t.eq(sys.type, "streamSystem", "system parsed");
  t.eq(sys.model, "KRITI", "model captured");

  const txt = parseLine('{"type":"text","text":"Working on it..."}', "t1");
  t.eq(txt.type, "streamText", "text parsed");
  t.eq(txt.text, "Working on it...", "text content preserved");

  const tc = parseLine('{"type":"tool_call","id":"call-1","name":"shell","arguments":{"cmd":"rm -rf /tmp/foo"}}', "t1");
  t.eq(tc.type, "streamToolCall", "tool_call parsed");
  t.eq(tc.request.risk, "critical", "tool_call risk classified as critical");

  const res = parseLine('{"type":"result","text":"Done!","exit_code":0}', "t1");
  t.eq(res.type, "streamResult", "result parsed");
  t.eq(res.exitCode, 0, "exit_code 0 preserved");
});

test("protocol", "unknown event kind and bad JSON become parseError, never throw", (t) => {
  t.eq(parseLine('HV_EVENT: {"kind":"banana"}', "t").type, "parseError", "unknown kind");
  t.eq(parseLine("HV_PERM: {oops", "t").type, "parseError", "bad json");
});

test("protocol", "unmarked lines degrade to plain text (graceful fallback)", (t) => {
  t.eq(parseLine("Omniroute healthy hai.", "t").type, "plain", "plain");
  t.eq(parseLine("   ", "t"), null, "blank ignored");
  t.eq(parseLine("HV_PROGRESS: step 1", "t").text, "step 1", "progress text");
});

test("protocol", "lineSplitter keeps partial lines until the newline arrives", (t) => {
  const s = lineSplitter();
  t.eq(s.push('HV_EVENT: {"ki'), [], "no partial emitted");
  t.eq(s.push('nd":"thinking"}\nHV_PROGRESS: x\n').length, 2, "two complete lines");
  t.eq(s.push("trailing"), [], "trailing held");
  t.eq(s.flush(), ["trailing"], "flush emits remainder");
});

test("protocol", "decision encoding and argv templating", (t) => {
  t.eq(encodeDecision("p1", "allowOnce"), `${MARKERS.decision} {"id":"p1","decision":"allowOnce"}\n`, "decision line");
  t.eq(buildArgv({ utterance: "hi", sessionId: "s1" }), ["chat", "-q", "hi", "--session", "s1"], "default argv");
  t.eq(
    buildArgv({ utterance: "hi", sessionId: "s1", argvTemplate: ["fake.mjs", "-q", "{{utterance}}", "--session", "{{sessionId}}"] }),
    ["fake.mjs", "-q", "hi", "--session", "s1"],
    "custom template substitutes both placeholders",
  );
});

/* -------------------------------- redaction ------------------------------- */

test("redaction", "known secret shapes are redacted", (t) => {
  for (const s of ["sk-abcdefghijklmnop1234", "AIzaSyDEMO1234567890abcdef", "ghp_abcdefghijklmnopqrstuvwxyz0", "password=SuperSecret123"]) {
    t.has(redact(s), REDACTED, `redacted ${s.slice(0, 10)}…`);
  }
});

test("redaction", "ordinary prose is untouched (no false positives)", (t) => {
  const s = "Omniroute healthy hai, latency 42 ms, 4 combos loaded.";
  t.eq(redact(s), s, "prose preserved");
});

test("redaction", "sensitive arg keys redact regardless of value shape", (t) => {
  const out = redactArgs({ path: "~/notes.md", gemini_api_key: "short" });
  t.eq(out.gemini_api_key, REDACTED, "sensitive key redacted");
  t.eq(out.path, "~/notes.md", "benign arg kept");
});

/* --------------------------------- risk ---------------------------------- */

test("risk", "matrix matches spec §30", (t) => {
  t.eq(classifyRisk("read_file").risk, "low", "read_file=low");
  t.eq(classifyRisk("write_file").risk, "medium", "write_file=medium");
  t.eq(classifyRisk("git_push").risk, "high", "git_push=high");
  t.eq(classifyRisk("read_credentials").risk, "critical", "credentials=critical");
  t.eq(classifyRisk("totally_unknown_tool").risk, "high", "unknown=high (conservative)");
});

test("risk", "policy gates: nothing dangerous is ever auto-approved", (t) => {
  t.true(canAutoApprove("low", true), "low auto-approvable only when opted in");
  t.true(!canAutoApprove("low", false), "default = no auto-approve");
  for (const r of ["medium", "high", "critical"]) t.true(!canAutoApprove(r, true), `${r} never auto-approved`);
  t.true(allowsVoiceApproval("medium"), "voice ok for medium");
  t.true(!allowsVoiceApproval("high"), "voice blocked for high");
  t.true(requiresTypedConfirm("critical"), "critical needs typed ALLOW");
});

/* ------------------------------ speech prep ------------------------------ */

test("speechPrep", "markdown/code/urls stripped and long text summarized", (t) => {
  const out = speechify("# Title\n`x` **b** [l](http://a.b)\n```js\nconst a=1\n```");
  t.hasNot(out, "```", "fences gone");
  t.hasNot(out, "http://a.b", "url not spelled out");
  const long = Array.from({ length: 40 }, (_, i) => `Sentence ${i} about the task.`).join(" ");
  t.has(summarizeForSpeech(long), "overlay", "long reply points to overlay");
});

test("speechPrep", "voice decisions map without guessing", (t) => {
  t.eq(mapVoiceDecision("haan kar do"), "allow", "haan=allow");
  t.eq(mapVoiceDecision("permission di"), "allow", "permission di=allow");
  t.eq(mapVoiceDecision("nahi ruko"), "deny", "nahi ruko=deny");
  t.eq(mapVoiceDecision("maybe later"), null, "ambiguous=null");
});

/* ------------------------------- omniroute ------------------------------- */

test("omniroute", "probe always sends stream:false (SSE gotcha)", async (t) => {
  const orig = globalThis.fetch;
  let body = "";
  let path = "";
  globalThis.fetch = async (url, init) => {
    path = new URL(String(url)).pathname;
    body = String(init?.body ?? "");
    return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), { status: 200 });
  };
  try {
    const r = await new OmnirouteClient("http://127.0.0.1:20128").chatProbe("opc/beam-free");
    t.true(r.ok, "probe parsed");
    t.eq(path, "/v1/chat/completions", "correct endpoint");
    t.has(body, '"stream":false', "stream:false present");
  } finally {
    globalThis.fetch = orig;
  }
});

test("omniroute", "client can only issue GET plus the single probe POST", async (t) => {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
    return new Response(JSON.stringify({ data: [], status: "ok" }), { status: 200 });
  };
  try {
    const c = new OmnirouteClient("http://127.0.0.1:20128");
    await c.health();
    await c.models();
    await c.combos();
    await c.chatProbe("x");
    const bad = seen.filter((s) => /^(PUT|PATCH|DELETE)/.test(s) || (s.startsWith("POST") && !s.includes("/v1/chat/completions")));
    t.eq(bad, [], "no mutating verb, no POST outside the probe");
  } finally {
    globalThis.fetch = orig;
  }
});

test("omniroute", "unreachable gateway degrades instead of throwing", async (t) => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  try {
    const h = await new OmnirouteClient("http://127.0.0.1:20128").health();
    t.true(!h.reachable, "reports unreachable");
    const c = await new OmnirouteClient("http://127.0.0.1:20128").combos();
    t.eq(c.pathUsed, null, "combos degrade to null path");
  } finally {
    globalThis.fetch = orig;
  }
});

/* --------------------------------- store --------------------------------- */

test("store", "audit append + list + clear round-trips with redaction", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hv-store-"));
  store.__setTestRoots(dir);
  try {
    store.appendAudit({ tool: "read_credentials", risk: "critical", decision: "deny", via: "click", args: { item: "gemini_api_key", value: "sk-abcdef1234567890" } });
    const rows = store.listAudit();
    t.eq(rows.length, 1, "one row written");
    t.eq(rows[0].decision, "deny", "decision stored");
    t.has(rows[0].args, REDACTED, "args redacted on write");
    t.hasNot(rows[0].args, "sk-abcdef", "no secret in the audit file");
    store.clearAudit();
    t.eq(store.listAudit().length, 0, "cleared");
  } finally {
    store.__setTestRoots(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store", "memory reader jails paths and refuses traversal", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hv-mem-"));
  writeFileSync(join(dir, "MEMORY.md"), "# memory\n");
  try {
    t.eq(store.readMemoryFile("MEMORY.md", dir).text.trim(), "# memory", "reads inside the jail");
    const e = t.throws(() => store.readMemoryFile("../../etc/passwd", dir), undefined, "traversal rejected");
    t.eq(e.status, 400, "400 for escape attempt");
    t.throws(() => store.readMemoryFile("nope.md", dir), undefined, "missing file throws");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store", "session retention prunes beyond 100 / 30 days", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hv-sess-"));
  store.__setTestRoots(dir);
  try {
    for (let i = 0; i < 105; i++) store.saveSession({ id: `s${i}`, startedAt: Date.now() - i * 1000, endedAt: null, status: "completed", utterances: [] });
    t.eq(store.listSessions().length, 100, "capped at 100");
  } finally {
    store.__setTestRoots(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tts", "engine detection reports honestly and never claims Gemini", async (t) => {
  ensureDirs();
  t.true(existsSync(TTS_CACHE_DIR), "tts-cache directory exists");
  t.true(Boolean(resolvePython()), "python runtime resolved");
  const engines = await detectEngines(null);
  t.eq(typeof engines.edge.available, "boolean", "edge probed, not assumed");
  t.eq(typeof engines.say.available, "boolean", "say probed, not assumed");
  t.eq(engines.gemini.available, false, "gemini deliberately unwired (daily cap)");
  t.has(engines.edge.detail, engines.edge.available ? "importable" : "missing", "detail explains the probe result");
});

/* ------------------------- integration: real bridge ---------------------- */

function managerConfig(overrides = {}) {
  return {
    maxConcurrentTasks: 3,
    hermes: { command: ["node"], argvTemplate: [FAKE, "chat", "-q", "{{utterance}}", "--session", "{{sessionId}}"], cwd: HERE, timeoutSec: 30, pathHint: [] },
    permissions: { timeoutSec: 8, autoApproveLowRisk: false },
    logging: { level: "warn", redact: true },
    ...overrides,
  };
}

async function until(pred, timeoutMs = 12000, what = "condition") {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = pred();
    if (v) return v;
    await sleep(40);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("integration", "spawns the agent, streams events, and completes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hv-int-"));
  store.__setTestRoots(dir);
  const log = new Logger({ level: "error" });
  const tm = new TaskManager({ config: managerConfig(), log });
  try {
    const task = await tm.start({ utterance: "just do a simple task", sessionId: "sess-1" });
    const answered = new Set();
    const done = await until(() => {
      const s = tm.get(task.id);
      for (const e of s.events) {
        if (e.type === "permissionRequest" && !answered.has(e.payload.request.id)) {
          answered.add(e.payload.request.id);
          tm.decide({ taskId: task.id, requestId: e.payload.request.id, decision: "allowOnce", via: "click" });
        }
      }
      return ["done", "failed", "cancelled"].includes(s.status) ? s : null;
    }, 20000, "task completion");
    const types = done.events.map((e) => e.type);
    t.eq(answered.size, 2, "both permissions answered");
    t.eq(types.filter((x) => x === "toolCall").length, 2, "both approved tools executed");
    t.has(types.join(","), "thinking", "thinking emitted");
    t.has(types.join(","), "permissionRequest", "permission requested");
    t.has(types.join(","), "completed", "completed emitted");
    t.eq(done.status, "done", "final status done");
    const completed = done.events.find((e) => e.type === "completed");
    t.has(completed.payload.text, "Kaam ho gaya", "agent summary carried through");
    const session = store.getSession("sess-1");
    t.eq(session.utterances.length, 2, "session persisted with user + assistant turns");
    t.eq(session.utterances[1].role, "assistant", "assistant turn recorded");
  } finally {
    tm.shutdown();
    store.__setTestRoots(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration", "stream-json mode: spawns agent, intercepts tool_call, relays HV_DECISION over stdin, and completes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hv-int-sjson-"));
  store.__setTestRoots(dir);
  const log = new Logger({ level: "error" });
  const tm = new TaskManager({
    config: managerConfig({
      hermes: {
        command: ["node"],
        argvTemplate: [FAKE, "chat", "-q", "{{utterance}}", "--format", "stream-json", "--session", "{{sessionId}}"],
        cwd: HERE,
        timeoutSec: 30,
        pathHint: [],
      },
    }),
    log,
  });
  try {
    const task = await tm.start({ utterance: "check omniroute health and combos", sessionId: "sess-sjson" });
    const answered = new Set();
    const done = await until(() => {
      const s = tm.get(task.id);
      for (const e of s.events) {
        if (e.type === "permissionRequest" && !answered.has(e.payload.request.id)) {
          answered.add(e.payload.request.id);
          tm.decide({ taskId: task.id, requestId: e.payload.request.id, decision: "allowOnce", via: "click" });
        }
      }
      return ["done", "failed", "cancelled"].includes(s.status) ? s : null;
    }, 20000, "stream-json completion");
    t.eq(answered.size, 2, "both stream-json tool_calls intercepted and approved");
    t.eq(done.status, "done", "stream-json task completed");
    t.eq(done.model, "KRITI / 9Router", "stream-json system init model captured");
  } finally {
    tm.shutdown();
    store.__setTestRoots(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration", "permission pause → allow → resume → tool actually runs", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hv-int2-"));
  store.__setTestRoots(dir);
  const tm = new TaskManager({ config: managerConfig(), log: new Logger({ level: "error" }) });
  try {
    const task = await tm.start({ utterance: "check omniroute health and combos", sessionId: "sess-2" });
    const perm = await until(() => tm.get(task.id).events.find((e) => e.type === "permissionRequest"), 10000, "first permission");
    t.eq(perm.payload.request.toolName, "web_fetch", "correct tool surfaced");
    t.eq(perm.payload.request.risk, "low", "read-only GET classified low");
    const out = tm.decide({ taskId: task.id, requestId: perm.payload.request.id, decision: "allowOnce", via: "click" });
    t.eq(out.deliveredToAgent, true, "HV_DECISION written to child stdin");
    const tool = await until(() => tm.get(task.id).events.find((e) => e.type === "toolCall"), 10000, "resumed toolCall");
    t.eq(tool.payload.name, "web_fetch", "agent resumed and ran the approved tool");
    const second = await until(
      () => tm.get(task.id).events.find((e) => e.type === "permissionRequest" && e.payload.request.id !== perm.payload.request.id),
      10000,
      "second permission",
    );
    t.eq(second.payload.request.toolName, "read_file", "second tool surfaced separately (queued, not merged)");
    tm.decide({ taskId: task.id, requestId: second.payload.request.id, decision: "deny", via: "click" });
    const done = await until(() => (["done", "failed"].includes(tm.get(task.id).status) ? tm.get(task.id) : null), 15000, "completion");
    const audits = store.listAudit();
    t.eq(audits.length, 2, "exactly two decisions audited — no phantom rows");
    t.eq(audits.map((a) => `${a.tool}:${a.decision}`).sort(), ["read_file:deny", "web_fetch:allowOnce"], "each decision recorded against its tool");
    t.eq(done.events.filter((e) => e.type === "toolCall").length, 1, "denied tool never executed");
    t.has(done.events.map((e) => e.type).join(","), "completed", "task completed after the deny");
    t.has(done.events.find((e) => e.type === "completed").payload.text, "read_file", "agent reports what it skipped");
  } finally {
    tm.shutdown();
    store.__setTestRoots(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration", "critical risk refuses voice + untyped approval", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hv-int3-"));
  store.__setTestRoots(dir);
  const tm = new TaskManager({ config: managerConfig(), log: new Logger({ level: "error" }) });
  try {
    const task = await tm.start({ utterance: "mera gemini api key padh ke batao", sessionId: "sess-3" });
    const perm = await until(() => tm.get(task.id).events.find((e) => e.type === "permissionRequest"), 10000, "critical permission");
    t.eq(perm.payload.request.risk, "critical", "credential access = critical");
    const reqId = perm.payload.request.id;
    await t.throwsAsync(Promise.resolve().then(() => tm.decide({ taskId: task.id, requestId: reqId, decision: "allowOnce", via: "voice" })), "voiceBlocked", "voice approval rejected for critical");
    await t.throwsAsync(Promise.resolve().then(() => tm.decide({ taskId: task.id, requestId: reqId, decision: "allowOnce", via: "click" })), "typedConfirmRequired", "untyped allow rejected");
    await t.throwsAsync(Promise.resolve().then(() => tm.decide({ taskId: task.id, requestId: reqId, decision: "allowSession", via: "click", typedConfirm: "ALLOW" })), "noSessionAllowlist", "critical can never be session-allowlisted");
    const ok = tm.decide({ taskId: task.id, requestId: reqId, decision: "allowOnce", via: "click", typedConfirm: "ALLOW" });
    t.eq(ok.deliveredToAgent, true, "typed ALLOW accepted and delivered");
    await until(() => ["done", "failed", "cancelled"].includes(tm.get(task.id).status), 15000, "completion");
    const row = store.listAudit().find((a) => a.tool === "read_credentials");
    t.has(row.args, REDACTED, "audit row redacted even for critical");
  } finally {
    tm.shutdown();
    store.__setTestRoots(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration", "permission timeout auto-denies and the agent continues", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hv-int4-"));
  store.__setTestRoots(dir);
  const tm = new TaskManager({ config: managerConfig({ permissions: { timeoutSec: 1.2, autoApproveLowRisk: false } }), log: new Logger({ level: "error" }) });
  try {
    const task = await tm.start({ utterance: "check router status", sessionId: "sess-4" });
    await until(() => tm.get(task.id).events.find((e) => e.type === "permissionRequest"), 10000, "permission");
    const decision = await until(() => tm.get(task.id).events.find((e) => e.type === "permissionDecision"), 8000, "auto decision");
    t.eq(decision.payload.decision, "timeout-deny", "auto-denied on timeout");
    t.eq(decision.payload.via, "timeout", "logged as timeout");
    t.eq(store.listAudit()[0].decision, "timeout-deny", "audit shows timeout-deny");
    await until(() => ["done", "failed", "cancelled"].includes(tm.get(task.id).status), 15000, "completion");
  } finally {
    tm.shutdown();
    store.__setTestRoots(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration", "agent-reported failure surfaces with a reason", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hv-int5-"));
  store.__setTestRoots(dir);
  const tm = new TaskManager({ config: managerConfig(), log: new Logger({ level: "error" }) });
  try {
    const task = await tm.start({ utterance: "please fail now", sessionId: "sess-5" });
    const failed = await until(() => tm.get(task.id).events.find((e) => e.type === "failed"), 15000, "failure event");
    t.has(failed.payload.reason, "simulated agent failure", "reason carried");
    await until(() => tm.get(task.id).status === "failed", 5000, "status failed");
  } finally {
    tm.shutdown();
    store.__setTestRoots(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration", "cancel kills the child process", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hv-int6-"));
  store.__setTestRoots(dir);
  const tm = new TaskManager({ config: managerConfig(), log: new Logger({ level: "error" }) });
  try {
    const task = await tm.start({ utterance: "run a slow task please", sessionId: "sess-6" });
    await sleep(300);
    tm.cancel(task.id);
    const s = tm.get(task.id);
    t.eq(s.status, "cancelled", "status cancelled");
    t.has(s.events.map((e) => e.type).join(","), "cancelled", "cancelled event emitted");
  } finally {
    tm.shutdown();
    store.__setTestRoots(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration", "concurrency hard cap rejects the excess task", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hv-int7-"));
  store.__setTestRoots(dir);
  const tm = new TaskManager({ config: managerConfig({ maxConcurrentTasks: 1 }), log: new Logger({ level: "error" }) });
  try {
    const first = await tm.start({ utterance: "run a slow task", sessionId: "sess-7" });
    await t.throwsAsync(tm.start({ utterance: "another one", sessionId: "sess-7b" }), "tooManyTasks", "second task rejected at cap");
    tm.cancel(first.id);
  } finally {
    tm.shutdown();
    store.__setTestRoots(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration", "missing agent binary is reported, not faked", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hv-int8-"));
  store.__setTestRoots(dir);
  const tm = new TaskManager({
    config: managerConfig({ hermes: { command: ["definitely-not-installed-xyz"], argvTemplate: ["chat"], cwd: HERE, timeoutSec: 5, pathHint: [] } }),
    log: new Logger({ level: "error" }),
  });
  try {
    await t.throwsAsync(tm.start({ utterance: "hello", sessionId: "s" }), "hermesNotFound", "hermesNotFound raised");
  } finally {
    tm.shutdown();
    store.__setTestRoots(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration", "hard timeout kills a hung agent", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hv-int9-"));
  store.__setTestRoots(dir);
  const tm = new TaskManager({
    config: managerConfig({
      hermes: { command: ["node"], argvTemplate: [FAKE, "chat", "-q", "{{utterance}}", "--session", "{{sessionId}}"], cwd: HERE, timeoutSec: 1, pathHint: [] },
    }),
    log: new Logger({ level: "error" }),
  });
  try {
    const task = await tm.start({ utterance: "slow timeout test", sessionId: "sess-9" });
    const failed = await until(() => tm.get(task.id).events.find((e) => e.type === "failed"), 12000, "timeout failure");
    t.eq(failed.payload.code, "hermesTimeout", "reported as hermesTimeout");
  } finally {
    tm.shutdown();
    store.__setTestRoots(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------------- runner -------------------------------- */

export async function runServerTests() {
  results.length = 0;
  for (const def of suites) {
    const logs = [];
    const t0 = Date.now();
    try {
      await def.fn(new T(logs));
      results.push({ suite: def.suite, name: def.name, ok: true, detail: logs.join("\n"), ms: Date.now() - t0 });
    } catch (e) {
      results.push({
        suite: def.suite,
        name: def.name,
        ok: false,
        detail: [...logs, "✗ " + (e.stack?.split("\n").slice(0, 3).join(" | ") ?? e.message)].join("\n"),
        ms: Date.now() - t0,
      });
    }
  }
  return results;
}

export const SUITE_COUNT = suites.length;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rs = await runServerTests();
  const failed = rs.filter((r) => !r.ok);
  const bySuite = {};
  for (const r of rs) (bySuite[r.suite] ??= []).push(r);
  for (const [suite, list] of Object.entries(bySuite)) {
    console.log(`\n${suite}`);
    for (const r of list) {
      console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name} \x1b[90m(${r.ms}ms)\x1b[0m`);
      if (!r.ok) console.log(r.detail.split("\n").map((l) => "      " + l).join("\n"));
    }
  }
  console.log(`\n${rs.length - failed.length}/${rs.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
