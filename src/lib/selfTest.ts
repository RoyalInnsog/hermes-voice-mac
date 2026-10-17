// Section 15 — XCTest-equivalent automated test suite, runnable in the app (v1.0).
// Covers: state machine, redactor, risk classifier, protocol parser (stream-json + HV_*),
// Omniroute read-only contract, voice decision grammar, and session retention.

import { attempt, canTransition, type StateName } from "./stateMachine";
import { redact, redactArgs } from "./redactor";
import { canAutoApprove, allowsVoiceApproval, classifyRisk, requiresTypedConfirm } from "./risk";
import { parseHermesLine } from "./agentBridge";
import { ALLOWED_METHODS, OmnirouteClient } from "./omniroute";
import { mapVoiceDecision, speechify } from "./speech";
import { prune } from "./store";
import type { Session } from "./types";

export interface TestResult {
  suite: string;
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

type Case = { suite: string; name: string; run: () => void | Promise<void> };

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
function eq<T>(actual: T, expected: T, msg?: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg ?? "mismatch"}: got ${a}, expected ${b}`);
}

const CASES: Case[] = [
  // ---- State Machine (Section 4.1) ----
  {
    suite: "StateMachine",
    name: "happy path: idle → listening → transcribing → thinking → speaking → idle",
    run: () => {
      let s: StateName = "idle";
      const step = (to: StateName) => {
        const r = attempt(s, to);
        assert(r.ok, `failed transition ${s} -> ${to}`);
        s = r.to;
      };
      step("listening");
      eq(s, "listening");
      step("transcribing");
      eq(s, "transcribing");
      step("thinking");
      eq(s, "thinking");
      step("speaking");
      eq(s, "speaking");
      step("idle");
      eq(s, "idle");
    },
  },
  {
    suite: "StateMachine",
    name: "permission branch: thinking → awaitingPermission → thinking on decision",
    run: () => {
      const r1 = attempt("thinking", "awaitingPermission");
      eq(r1.ok, true);
      eq(r1.to, "awaitingPermission");
      const r2 = attempt("awaitingPermission", "thinking");
      eq(r2.ok, true);
      eq(r2.to, "thinking");
    },
  },
  {
    suite: "StateMachine",
    name: "illegal transitions are rejected and logged, state preserved",
    run: () => {
      assert(!canTransition("idle", "awaitingPermission"), "idle -> awaitingPermission must be invalid");
      const r = attempt("idle", "awaitingPermission");
      eq(r.ok, false);
    },
  },
  {
    suite: "StateMachine",
    name: "cancel works from thinking/awaitingPermission and returns to idle",
    run: () => {
      for (const busy of ["thinking", "awaitingPermission"] as StateName[]) {
        const r1 = attempt(busy, "cancelling");
        eq(r1.ok, true, `from ${busy}`);
        const r2 = attempt("cancelling", "idle");
        eq(r2.ok, true);
      }
    },
  },

  // ---- Redactor (Section 12.2 / 15.1) ----
  {
    suite: "Redactor",
    name: "redacts sk- keys, AIza Google keys, Bearer tokens, and key=value pairs",
    run: () => {
      const raw = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 key=sk-proj-abcdef012345678901234567 and AIzaSyD-9876543210abcdefghijklmnopqrstuv";
      const out = redact(raw);
      assert(!out.includes("eyJhbGci"), "JWT leaked");
      assert(!out.includes("sk-proj-"), "sk- leaked");
      assert(!out.includes("AIzaSy"), "AIza leaked");
      assert(out.includes("[REDACTED]"), "marker missing");
    },
  },
  {
    suite: "Redactor",
    name: "redacts sensitive keys in tool args while keeping safe paths intact",
    run: () => {
      const clean = redactArgs({ path: "~/project/README.md", api_key: "secretValue123456" });
      eq(clean.path, "~/project/README.md");
      eq(clean.api_key, "[REDACTED]");
    },
  },

  // ---- Risk Classifier (Section 6.7 / 15.1) ----
  {
    suite: "Risk",
    name: "classifies known tools and escalates unknown tools to high",
    run: () => {
      eq(classifyRisk("read_file", { path: "a.txt" }).risk, "low");
      eq(classifyRisk("write_file", { path: "a.txt" }).risk, "medium");
      eq(classifyRisk("git_push", {}).risk, "high");
      eq(classifyRisk("totally_unknown_tool", {}).risk, "high");
    },
  },
  {
    suite: "Risk",
    name: "argument danger patterns escalate shell/file tools to critical",
    run: () => {
      eq(classifyRisk("shell", { command: "rm -rf /tmp/build" }).risk, "critical");
      eq(classifyRisk("shell", { command: "sudo launchctl list" }).risk, "critical");
      eq(classifyRisk("read_file", { path: "~/.ssh/id_rsa" }).risk, "critical");
    },
  },
  {
    suite: "Risk",
    name: "voice approval & typed ALLOW gates follow Section 6.7 matrix",
    run: () => {
      eq(allowsVoiceApproval("low", true), true);
      eq(allowsVoiceApproval("medium", true), true);
      eq(allowsVoiceApproval("high", true), false);
      eq(allowsVoiceApproval("critical", true), false);
      eq(requiresTypedConfirm("critical"), true);
      eq(requiresTypedConfirm("high"), false);
      eq(canAutoApprove("low", true), true);
      eq(canAutoApprove("medium", true), false);
    },
  },

  // ---- Agent Wire Protocol (Section 6.5 / v1.0 stream-json + HV_*) ----
  {
    suite: "Protocol",
    name: "parses stream-json system, text, tool_call, and result lines",
    run: () => {
      const sys = parseHermesLine('{"type":"system","subtype":"init","model":"KRITI / 9Router","session_id":"s1"}', "t1");
      eq(sys?.type, "event");
      const txt = parseHermesLine('{"type":"text","text":"Checking OmniRoute combos..."}', "t1");
      eq(txt?.type, "progress");
      const tc = parseHermesLine('{"type":"tool_call","id":"call_9","name":"shell","arguments":{"command":"rm -rf /tmp/x"}}', "t1");
      eq(tc?.type, "permission");
      if (tc?.type === "permission") {
        eq(tc.request.risk, "critical");
        eq(tc.request.id, "call_9");
      }
      const res = parseHermesLine('{"type":"result","text":"Done.","exit_code":0}', "t1");
      eq(res?.type, "event");
    },
  },
  {
    suite: "Protocol",
    name: "parses HV_EVENT, HV_PERM, HV_PROGRESS, and falls back to plain text on malformed input",
    run: () => {
      const e1 = parseHermesLine('HV_EVENT: {"kind":"thinking","detail":"planning"}', "t1");
      eq(e1?.type, "event");
      const e2 = parseHermesLine('HV_PERM: {"id":"p1","tool":"shell","args":{"command":"rm -rf build"},"reason":"clean"}', "t1");
      eq(e2?.type, "permission");
      if (e2?.type === "permission") eq(e2.request.risk, "critical");
      const e3 = parseHermesLine("HV_PROGRESS: step 2 of 3", "t1");
      eq(e3?.type, "progress");
      const e4 = parseHermesLine("HV_EVENT: {not valid json", "t1");
      eq(e4?.type, "parseError");
      const e5 = parseHermesLine("plain stdout line from hermes", "t1");
      eq(e5?.type, "plain");
    },
  },

  // ---- Omniroute Read-Only Contract (Section 6.6 / 10.2) ----
  {
    suite: "Omniroute",
    name: "enforces read-only methods (GET + POST:/v1/chat/completions only)",
    run: () => {
      eq(ALLOWED_METHODS, ["GET", "POST:/v1/chat/completions"]);
      const client = new OmnirouteClient("http://127.0.0.1:20128");
      const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(client));
      for (const m of proto) {
        assert(!/delete|put|patch|write|restart|kill|mutate|update/i.test(m), `forbidden method on OmnirouteClient: ${m}`);
      }
    },
  },

  // ---- Speech helpers (Section 6.7 / 6.8) ----
  {
    suite: "Speech",
    name: "maps Hinglish/English voice replies to permission decisions & strips markdown for TTS",
    run: () => {
      eq(mapVoiceDecision("Haan kar do"), "allowOnce");
      eq(mapVoiceDecision("permission di"), "allowOnce");
      eq(mapVoiceDecision("theek hai allow"), "allowOnce");
      eq(mapVoiceDecision("session ke liye allow"), "allowSession");
      eq(mapVoiceDecision("nahi ruko"), "deny");
      eq(mapVoiceDecision("mat kar"), "deny");
      eq(mapVoiceDecision("random sentence"), null);
      const spoken = speechify("Done: ```sh\nrm -rf a\n``` See `src/App.tsx` and https://example.com/x");
      assert(!spoken.includes("```"), "code block not stripped");
      assert(!spoken.includes("https://"), "URL not stripped");
    },
  },

  // ---- Retention (Section 7 / 12.3) ----
  {
    suite: "Retention",
    name: "prunes sessions older than 30 days and caps at 100 newest",
    run: () => {
      const now = Date.now();
      const old: Session = { id: "old", startedAt: now - 31 * 86400_000, endedAt: null, status: "completed", utterances: [], taskIds: [] };
      const many: Session[] = Array.from({ length: 105 }, (_, i) => ({
        id: `s-${i}`,
        startedAt: now - i * 1000,
        endedAt: null,
        status: "completed",
        utterances: [],
        taskIds: [],
      }));
      const kept = prune([old, ...many]);
      eq(kept.length, 100);
      assert(!kept.some((s) => s.id === "old"), "31-day-old session was not pruned");
    },
  },
];

export async function runSelfTests(): Promise<TestResult[]> {
  const out: TestResult[] = [];
  for (const c of CASES) {
    const t0 = performance.now();
    try {
      await c.run();
      out.push({ suite: c.suite, name: c.name, ok: true, detail: "PASS", ms: Math.round(performance.now() - t0) });
    } catch (e) {
      out.push({
        suite: c.suite,
        name: c.name,
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
        ms: Math.round(performance.now() - t0),
      });
    }
  }
  return out;
}

export const TEST_COUNT = CASES.length;
