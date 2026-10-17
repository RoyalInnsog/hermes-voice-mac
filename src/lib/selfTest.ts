// Section 15 — test suite. The native build uses XCTest; this build ships the
// same assertions as an in-app runnable suite so the logic can be verified
// adversarially without Xcode (see LIMITATIONS.md → L-4).

import { attempt, canTransition, TRANSITIONS, type StateName } from "./stateMachine";
import { redact, redactArgs, REDACTED } from "./redactor";
import { allowsVoiceApproval, canAutoApprove, classifyRisk, requiresTypedConfirm } from "./risk";
import { buildHermesArgv, encodeDecision, parseHermesLine } from "./agentBridge";
import { mapVoiceDecision, speechify, summarizeForSpeech } from "./speech";
import { prune } from "./store";
import { OmnirouteClient } from "./omniroute";
import type { PermissionRequest, Session } from "./types";

export interface TestResult {
  suite: string;
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

class Assert {
  constructor(private log: string[]) {}
  true(cond: boolean, msg: string) {
    if (!cond) throw new Error("expected true: " + msg);
    this.log.push("✓ " + msg);
  }
  eq<T>(a: T, b: T, msg: string) {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
    this.log.push(`✓ ${msg}`);
  }
  contains(hay: string, needle: string, msg: string) {
    if (!hay.includes(needle)) throw new Error(`${msg} — ${JSON.stringify(hay)} missing ${JSON.stringify(needle)}`);
    this.log.push("✓ " + msg);
  }
  notContains(hay: string, needle: string, msg: string) {
    if (hay.includes(needle)) throw new Error(`${msg} — ${JSON.stringify(hay)} must not contain ${JSON.stringify(needle)}`);
    this.log.push("✓ " + msg);
  }
}

type TestFn = (t: Assert) => void | Promise<void>;
interface TestDef {
  suite: string;
  name: string;
  fn: TestFn;
}

const tests: TestDef[] = [];
const suite = (suiteName: string, name: string, fn: TestFn) => tests.push({ suite: suiteName, name, fn });

/* ---------------------- AppStateMachineTests ---------------------- */

suite("AppStateMachine", "every declared transition is accepted", (t) => {
  for (const [from, tos] of Object.entries(TRANSITIONS) as [StateName, StateName[]][]) {
    for (const to of tos) t.true(canTransition(from, to), `${from} → ${to}`);
  }
});

suite("AppStateMachine", "invalid transitions are rejected, not thrown", (t) => {
  const bad: [StateName, StateName][] = [
    ["idle", "awaitingPermission"],
    ["listening", "speaking"],
    ["speaking", "awaitingPermission"],
    ["cancelling", "thinking"],
    ["error", "listening"],
  ];
  for (const [from, to] of bad) {
    const r = attempt(from, to);
    t.true(!r.ok, `rejected ${from} → ${to}`);
    t.contains(r.reason ?? "", "invalid transition", "reason explains rejection");
  }
});

suite("AppStateMachine", "cancel path reachable from every busy state", (t) => {
  for (const s of ["thinking", "awaitingPermission"] as StateName[]) t.true(canTransition(s, "cancelling"), `${s} → cancelling`);
  t.true(canTransition("listening", "idle"), "listening → idle (cancel)");
  t.true(canTransition("cancelling", "idle"), "cancelling → idle");
});

/* ---------------------------- RedactorTests ---------------------------- */

suite("Redactor", "known key shapes are redacted", (t) => {
  const samples = [
    "key sk-abcdef1234567890abcdef",
    "google AIzaSyB1234567890abcdefghijklmn",
    "github ghp_abcdefghijklmnopqrstuvwxyz0123",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
  ];
  for (const s of samples) {
    const out = redact(s);
    t.contains(out, REDACTED, `redacted: ${s.slice(0, 12)}…`);
  }
});

suite("Redactor", "key=value pairs are redacted but keys kept", (t) => {
  const out = redact('api_key="supersecretvalue123" password=hunter2hunter2');
  t.contains(out, "api_key=", "key name survives");
  t.notContains(out, "supersecretvalue123", "secret value gone");
  t.notContains(out, "hunter2hunter2", "password gone");
});

suite("Redactor", "ordinary prose is untouched", (t) => {
  const s = "Omniroute healthy hai, latency 42 ms, 4 combos loaded.";
  t.eq(redact(s), s, "no false positive on prose");
});

suite("Redactor", "sensitive arg keys redact regardless of value", (t) => {
  const out = redactArgs({ path: "~/notes.md", gemini_api_key: "short" });
  t.eq(out.gemini_api_key, REDACTED, "sensitive key redacted");
  t.eq(out.path, "~/notes.md", "benign arg preserved");
});

/* ------------------------- RiskClassifierTests ------------------------- */

suite("RiskClassifier", "known tools map to the spec matrix", (t) => {
  t.eq(classifyRisk("read_file", { path: "a.md" }).risk, "low", "read_file = low");
  t.eq(classifyRisk("write_file", { path: "a.md" }).risk, "medium", "write_file = medium");
  t.eq(classifyRisk("git_push", {}).risk, "high", "git_push = high");
  t.eq(classifyRisk("read_credentials", {}).risk, "critical", "credential access = critical");
});

suite("RiskClassifier", "unknown tool defaults to high", (t) => {
  t.eq(classifyRisk("frobnicate_everything", {}).risk, "high", "unknown = high");
});

suite("RiskClassifier", "dangerous args escalate to critical", (t) => {
  t.eq(classifyRisk("shell", { cmd: "rm -rf /" }).risk, "critical", "rm -rf escalates");
  t.eq(classifyRisk("shell", { cmd: "sudo launchctl unload x" }).risk, "critical", "sudo escalates");
  t.eq(classifyRisk("read_file", { path: "~/.ssh/id_rsa" }).risk, "critical", "ssh key path escalates");
});

suite("RiskClassifier", "policy gates match the matrix", (t) => {
  t.true(canAutoApprove("low", true), "low auto-approvable when opted in");
  t.true(!canAutoApprove("low", false), "default policy does not auto-approve");
  t.true(!canAutoApprove("medium", true), "medium never auto-approved");
  t.true(!canAutoApprove("critical", true), "critical never auto-approved");
  t.true(allowsVoiceApproval("medium"), "voice ok for medium");
  t.true(!allowsVoiceApproval("high"), "voice blocked for high");
  t.true(requiresTypedConfirm("critical"), "critical needs typed ALLOW");
});

/* --------------------------- AgentBridgeTests -------------------------- */

suite("AgentBridge", "HV_EVENT lines parse into typed events", (t) => {
  const p = parseHermesLine('HV_EVENT: {"kind":"completed","text":"done"}', "task1");
  t.eq(p?.type, "event", "typed as event");
  if (p?.type === "event" && p.event.kind === "completed") t.eq(p.event.text, "done", "payload carried");
});

suite("AgentBridge", "HV_PERM lines build a permission request with risk", (t) => {
  const p = parseHermesLine('HV_PERM: {"tool":"shell","args":{"cmd":"rm -rf ~/x"}}', "task1");
  t.eq(p?.type, "permission", "typed as permission");
  if (p?.type === "permission") {
    t.eq(p.request.risk, "critical", "risk computed when absent");
    t.eq(p.request.taskID, "task1", "task id attached");
  }
});

suite("AgentBridge", "unmarked output degrades to plain text", (t) => {
  const p = parseHermesLine("Omniroute healthy hai.", "t");
  t.eq(p?.type, "plain", "plain fallback, no crash");
});

suite("AgentBridge", "malformed JSON yields parseError, never throws", (t) => {
  const p = parseHermesLine("HV_EVENT: {not json", "t");
  t.eq(p?.type, "parseError", "parseError returned");
});

suite("AgentBridge", "blank lines are ignored", (t) => {
  t.eq(parseHermesLine("   ", "t"), null, "null for whitespace");
});

suite("AgentBridge", "decision encoding round-trips", (t) => {
  const req = { id: "abc", toolName: "shell" } as PermissionRequest;
  const line = encodeDecision(req, "allowOnce");
  t.contains(line, "HV_DECISION:", "decision marker present");
  const parsed = JSON.parse(line.replace("HV_DECISION:", "").trim()) as { id: string; decision: string };
  t.eq(parsed, { id: "abc", decision: "allowOnce" }, "payload round-trips");
});

suite("AgentBridge", "argv supports both stream-json (v1.0) and session flag", (t) => {
  t.eq(buildHermesArgv({ utterance: "hi", sessionId: "s1" }), ["chat", "-q", "hi", "--session", "s1"], "session argv shape");
  t.eq(
    buildHermesArgv({ utterance: "hi", sessionId: "s1", streamJson: true }),
    ["chat", "-q", "hi", "--format", "stream-json"],
    "stream-json argv shape",
  );
});

suite("AgentBridge", "stream-json chunks (system, text, tool_call, result) parse cleanly", (t) => {
  const sys = parseHermesLine('{"type":"system","subtype":"init","model":"KRITI","session_id":"s1"}', "task1");
  t.eq(sys?.type, "progress", "system init parsed as progress");
  const tc = parseHermesLine('{"type":"tool_call","name":"shell","arguments":{"cmd":"rm -rf /tmp/z"}}', "task1");
  t.eq(tc?.type, "permission", "tool_call parsed as permission");
  if (tc?.type === "permission") t.eq(tc.request.risk, "critical", "rm -rf escalated to critical");
  const res = parseHermesLine('{"type":"result","text":"Task ho gaya","exit_code":0}', "task1");
  t.eq(res?.type, "event", "result parsed as event");
});

/* --------------------------- OmnirouteTests ---------------------------- */

suite("OmnirouteClient", "probe always sends stream:false", async (t) => {
  const orig = globalThis.fetch;
  let captured: { url: string; method: string; body: string } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = { url: String(input), method: init?.method ?? "GET", body: String(init?.body ?? "") };
    return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const res = await new OmnirouteClient("http://127.0.0.1:20128").chatProbe("opc/beam-free");
    t.true(res.ok, "probe parsed");
    const cap = captured as unknown as { url: string; method: string; body: string } | null;
    t.true(cap !== null, "request issued");
    t.contains(cap!.body, '"stream":false', "stream:false present (SSE gotcha)");
    t.contains(cap!.url, "/v1/chat/completions", "correct endpoint");
  } finally {
    globalThis.fetch = orig;
  }
});

suite("OmnirouteClient", "never issues a mutating verb", async (t) => {
  const orig = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    methods.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
    return new Response(JSON.stringify({ data: [], status: "ok" }), { status: 200 });
  }) as typeof fetch;
  try {
    const c = new OmnirouteClient("http://127.0.0.1:20128");
    await c.health();
    await c.models();
    await c.combos();
    await c.chatProbe("x");
    const bad = methods.filter((m) => /^(PUT|PATCH|DELETE)/.test(m) || (m.startsWith("POST") && !m.includes("/v1/chat/completions")));
    t.eq(bad, [], "no PUT/PATCH/DELETE and no POST outside the probe endpoint");
  } finally {
    globalThis.fetch = orig;
  }
});

suite("OmnirouteClient", "unreachable router degrades, does not throw", async (t) => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("connection refused");
  }) as typeof fetch;
  try {
    const h = await new OmnirouteClient("http://127.0.0.1:20128").health();
    t.true(!h.reachable, "reports unreachable");
    t.contains(h.detail, "no response", "detail explains");
  } finally {
    globalThis.fetch = orig;
  }
});

/* ------------------------------ TTS tests ------------------------------ */

suite("SpeechPrep", "markdown and code are stripped before speaking", (t) => {
  const out = speechify("# Head\n`code` **bold** [link](http://x.com)\n```js\nconst a=1;\n```");
  t.notContains(out, "```", "fences gone");
  t.notContains(out, "**", "bold markers gone");
  t.notContains(out, "http://x.com", "url not spelled out");
});

suite("SpeechPrep", "long text is summarized with an overlay pointer", (t) => {
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about the task.`).join(" ");
  const out = summarizeForSpeech(long);
  t.true(out.length < long.length, "shortened");
  t.contains(out, "overlay", "points to overlay for full report");
});

suite("VoiceCommands", "hinglish and english approvals map correctly", (t) => {
  t.eq(mapVoiceDecision("haan kar do"), "allow", "haan kar do = allow");
  t.eq(mapVoiceDecision("permission di"), "allow", "permission di = allow");
  t.eq(mapVoiceDecision("kar de"), "allow", "kar de = allow");
  t.eq(mapVoiceDecision("theek hai"), "allow", "theek hai = allow");
  t.eq(mapVoiceDecision("Allow"), "allow", "allow = allow");
  t.eq(mapVoiceDecision("nahi ruko"), "deny", "nahi ruko = deny");
  t.eq(mapVoiceDecision("mat kar"), "deny", "mat kar = deny");
  t.eq(mapVoiceDecision("nahi"), "deny", "nahi = deny");
  t.eq(mapVoiceDecision("no thanks"), "deny", "no = deny");
  t.eq(mapVoiceDecision("maybe later"), null, "ambiguous = null (no guessing)");
});

/* ---------------------------- Store tests ------------------------------ */

suite("SessionStore", "retention keeps 100 newest and drops >30 days", (t) => {
  const now = Date.now();
  const mk = (i: number, age: number): Session => ({
    schemaVersion: 1,
    id: "s" + i,
    startedAt: now - age,
    endedAt: null,
    status: "completed",
    utterances: [],
  });
  const list = [...Array.from({ length: 150 }, (_, i) => mk(i, i * 1000)), mk(999, 40 * 24 * 3600 * 1000)];
  const kept = prune(list);
  t.eq(kept.length, 100, "capped at 100");
  t.true(!kept.some((s) => s.id === "s999"), "40-day-old session dropped");
  t.eq(kept[0].id, "s0", "newest first");
});

/* ------------------------------- runner -------------------------------- */

export async function runSelfTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const def of tests) {
    const log: string[] = [];
    const t0 = performance.now();
    try {
      await def.fn(new Assert(log));
      results.push({ suite: def.suite, name: def.name, ok: true, detail: log.join("\n"), ms: Math.round(performance.now() - t0) });
    } catch (e) {
      results.push({
        suite: def.suite,
        name: def.name,
        ok: false,
        detail: [...log, "✗ " + (e instanceof Error ? e.message : String(e))].join("\n"),
        ms: Math.round(performance.now() - t0),
      });
    }
  }
  return results;
}

export const TEST_COUNT = tests.length;
