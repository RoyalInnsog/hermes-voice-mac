#!/usr/bin/env node
// server/fake-hermes.mjs — deterministic Hermes CLI simulator supporting BOTH:
//   1. `--format stream-json` (v1.0 JSON stream chunks: system, text, tool_call, result)
//   2. Legacy HV_* marker lines (HV_EVENT, HV_PERM, HV_PROGRESS)
//
// Usage:
//   HV_HERMES_CMD="node server/fake-hermes.mjs" node server/index.mjs

import { classifyRisk } from "./risk.mjs";

const args = process.argv.slice(2);
const qIdx = args.indexOf("-q");
const utterance = qIdx >= 0 ? args[qIdx + 1] ?? "" : "";
const sIdx = args.indexOf("--session");
const sessionId = sIdx >= 0 ? args[sIdx + 1] ?? "" : "";
const fIdx = args.indexOf("--format");
const format = fIdx >= 0 ? args[fIdx + 1] ?? "" : "";
const isStreamJson = format === "stream-json" || args.includes("--stream-json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (line) => process.stdout.write(line + "\n");
const event = (kind, payload = {}) => out(`HV_EVENT: ${JSON.stringify({ kind, ...payload })}`);
const progress = (text) =>
  isStreamJson ? out(JSON.stringify({ type: "text", text })) : out(`HV_PROGRESS: ${text}`);

/* --------------------------- stdin decision pump -------------------------- */

const decisions = new Map();
const waiters = new Map();
let stdinBuf = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk;
  let i;
  while ((i = stdinBuf.indexOf("\n")) >= 0) {
    const line = stdinBuf.slice(0, i).trim();
    stdinBuf = stdinBuf.slice(i + 1);
    if (!line.startsWith("HV_DECISION:")) continue;
    try {
      const d = JSON.parse(line.slice("HV_DECISION:".length).trim());
      decisions.set(d.id, d.decision);
      waiters.get(d.id)?.(d.decision);
      waiters.delete(d.id);
    } catch {
      process.stderr.write("fake-hermes: malformed HV_DECISION line\n");
    }
  }
});

function awaitDecision(id, timeoutMs = 60000) {
  if (decisions.has(id)) return Promise.resolve(decisions.get(id));
  return new Promise((resolve) => {
    waiters.set(id, resolve);
    setTimeout(() => {
      if (!decisions.has(id)) resolve("timeout-no-answer");
    }, timeoutMs);
  });
}

/* --------------------------------- plan ---------------------------------- */

const SCENARIOS = [
  {
    match: /health|omniroute|router|status/i,
    steps: [
      { progress: "Omniroute health endpoint hit kar raha hoon" },
      { perm: { tool: "web_fetch", args: { url: "http://127.0.0.1:20128/api/health" }, reason: "read-only GET" } },
      { progress: "Combos read-only padh raha hoon" },
      { perm: { tool: "read_file", args: { path: "~/.9router/db/data.sqlite", mode: "read-only" } } },
    ],
    summary: "Omniroute healthy hai, latency 42ms. 4 combos loaded (read-only): KRITI(5), FALLBACK-FREE(3), VISION(2), LONGCTX(4). Kuch edit nahi kiya.",
  },
  {
    match: /commit|git|push|repo/i,
    steps: [
      { perm: { tool: "git_status", args: { repo: "~/Documents/Projects/hermes-voice-mac" } } },
      { progress: "Diff summarize kar raha hoon" },
      { perm: { tool: "git_commit", args: { message: "feat(voice): real local bridge" } } },
      { progress: "Push deliberately skip — user approval nahi chahiye tha" },
    ],
    summary: "Local commit ban gaya: feat(voice): real local bridge. Push nahi kiya (rule: push only on your word).",
  },
  {
    match: /key|secret|credential|token|password/i,
    steps: [{ perm: { tool: "read_credentials", args: { store: "Keychain", item: "gemini_api_key", api_key: "AIzaSyDEMO1234567890abcdef" } } }],
    summary: "Credential request bana tha. Value kabhi plaintext me nahi dikhti — sirf [REDACTED].",
  },
  {
    match: /delete|clean|purge|rm\b/i,
    steps: [
      { perm: { tool: "list_dir", args: { path: "~/.hermes/cache/scratch" } } },
      { perm: { tool: "shell", args: { cmd: "rm -rf ~/.hermes/cache/scratch/*" } } },
    ],
    summary: "Scratch cleanup ka plan ready tha; jo permission mili wahi chala.",
  },
  {
    match: /fail|error|crash/i,
    steps: [{ progress: "Jaan-boojh ke fail ho raha hoon" }],
    summary: null,
    fail: "simulated agent failure (requested by utterance)",
  },
  {
    match: /slow|timeout/i,
    steps: [{ progress: "Ye task deliberately slow hai", sleep: 4000 }],
    summary: "Slow task complete.",
  },
];

const DEFAULT = {
  match: /.*/,
  steps: [
    { progress: "Task plan bana raha hoon" },
    { perm: { tool: "read_file", args: { path: "~/.hermes/memories/MEMORY.md" } } },
    { progress: "Memory context load ho gaya" },
    { perm: { tool: "search", args: { query: utterance.slice(0, 40) || "latest notes" } } },
  ],
  summary: "Kaam ho gaya. Memory se context load kiya, plan banaya, execute kiya. Poora transcript session me save hai.",
};

const scenario = SCENARIOS.find((s) => s.match.test(utterance)) ?? DEFAULT;

/* --------------------------------- run ----------------------------------- */

async function main() {
  if (isStreamJson) {
    out(JSON.stringify({ type: "system", subtype: "init", model: "KRITI / 9Router", session_id: sessionId || "default" }));
  } else {
    progress(`fake-hermes online — session ${sessionId || "(none)"}, utterance "${utterance.slice(0, 60)}"`);
    event("thinking");
  }
  await sleep(180);

  const denied = [];
  let seq = 0;

  for (const step of scenario.steps) {
    if (step.sleep) await sleep(step.sleep);
    if (step.progress) {
      progress(step.progress);
      await sleep(220);
    }
    if (step.perm) {
      const id = `perm-${++seq}`;
      const { risk, note } = classifyRisk(step.perm.tool, step.perm.args);
      if (isStreamJson) {
        out(
          JSON.stringify({
            type: "tool_call",
            id,
            name: step.perm.tool,
            arguments: step.perm.args,
            reason: step.perm.reason ?? note,
            risk,
          }),
        );
      } else {
        out(`HV_PERM: ${JSON.stringify({ id, tool: step.perm.tool, args: step.perm.args, reason: step.perm.reason ?? note, risk })}`);
      }
      const decision = await awaitDecision(id);
      if (decision === "deny" || decision === "timeout-no-answer") {
        denied.push(step.perm.tool);
        progress(`${step.perm.tool} skip kiya (${decision})`);
        await sleep(120);
        continue;
      }
      if (!isStreamJson) {
        event("toolCall", { name: step.perm.tool, args: step.perm.args });
      }
      await sleep(250);
    }
    if (step.tool) {
      if (isStreamJson) {
        out(JSON.stringify({ type: "tool_call", id: `tool-${++seq}`, name: step.tool, arguments: step.args ?? {} }));
      } else {
        event("toolCall", { name: step.tool, args: step.args ?? {} });
      }
      await sleep(250);
    }
  }

  if (scenario.fail) {
    if (isStreamJson) {
      out(JSON.stringify({ type: "result", text: scenario.fail, exit_code: 2 }));
    } else {
      event("failed", { reason: scenario.fail });
    }
    process.exit(2);
  }

  const suffix = denied.length ? ` Denied tools skip kiye: ${denied.join(", ")}.` : "";
  const finalText = scenario.summary + suffix;
  if (isStreamJson) {
    out(JSON.stringify({ type: "result", text: finalText, exit_code: 0 }));
  } else {
    event("completed", { text: finalText });
  }
  process.exit(0);
}

if (!utterance && args.length === 0) {
  out("fake-hermes: pass `-q \"text\"` (or HV_HERMES_CMD='node server/fake-hermes.mjs')");
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`fake-hermes crashed: ${e.stack}\n`);
  process.exit(3);
});
