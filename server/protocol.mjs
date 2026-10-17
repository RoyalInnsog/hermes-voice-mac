// server/protocol.mjs — Hermes wire protocol (server side).
// Identical semantics to src/lib/agentBridge.ts so browser and Node agree.
//
// Wire format (one JSON object per stdout line, marker-prefixed):
//   HV_EVENT:    {"kind":"thinking|toolCall|progress|completed|failed|cancelled", ...}
//   HV_PERM:     {"tool":"shell","args":{...},"reason":"...","risk":"high"?, "id"?}
//   HV_PROGRESS: <free text>
//   <anything else> = plain assistant text (graceful fallback)
//
// Decision written back to the child's stdin:
//   HV_DECISION: {"id":"<permId>","decision":"allowOnce|allowSession|deny"}
//
// TODO-VERIFY: whether the installed `hermes` emits any of this. If it does not,
// the bridge degrades to "whole stdout = final response" and permission
// interception is unavailable (LIMITATIONS L-2). Run: hermes chat --help

import { classifyRisk } from "./risk.mjs";

export const MARKERS = {
  event: "HV_EVENT:",
  perm: "HV_PERM:",
  progress: "HV_PROGRESS:",
  decision: "HV_DECISION:",
};

export const EVENT_KINDS = ["thinking", "toolCall", "progress", "completed", "failed", "cancelled"];
export const RISKS = ["low", "medium", "high", "critical"];
export const DECISIONS = ["allowOnce", "allowSession", "deny"];

export function parseLine(line, taskID) {
  const trimmed = (line ?? "").replace(/\r$/, "").trim();
  if (!trimmed) return null;

  if (trimmed.startsWith(MARKERS.progress)) {
    return { type: "progress", text: trimmed.slice(MARKERS.progress.length).trim() };
  }

  if (trimmed.startsWith(MARKERS.perm)) {
    const raw = trimmed.slice(MARKERS.perm.length).trim();
    try {
      const o = JSON.parse(raw);
      const toolName = String(o.tool ?? "unknown_tool");
      const args = o.args && typeof o.args === "object" ? o.args : {};
      const classified = classifyRisk(toolName, args);
      const risk = RISKS.includes(o.risk) ? o.risk : classified.risk;
      return {
        type: "permission",
        request: { id: String(o.id ?? crypto.randomUUID()), taskID, toolName, args, risk, reason: o.reason ?? classified.note },
      };
    } catch (e) {
      return { type: "parseError", raw, error: e.message };
    }
  }

  if (trimmed.startsWith(MARKERS.event)) {
    const raw = trimmed.slice(MARKERS.event.length).trim();
    try {
      const o = JSON.parse(raw);
      const kind = String(o.kind ?? "");
      if (!EVENT_KINDS.includes(kind)) return { type: "parseError", raw, error: `unknown event kind "${kind}"` };
      switch (kind) {
        case "thinking":
          return { type: "event", event: { kind, taskID } };
        case "toolCall":
          return { type: "event", event: { kind, taskID, name: String(o.name ?? "tool"), args: o.args ?? {} } };
        case "progress":
          return { type: "event", event: { kind, taskID, text: String(o.text ?? "") } };
        case "completed":
          return { type: "event", event: { kind, taskID, text: String(o.text ?? "") } };
        case "failed":
          return { type: "event", event: { kind, taskID, reason: String(o.reason ?? "unknown") } };
        case "cancelled":
          return { type: "event", event: { kind, taskID } };
      }
    } catch (e) {
      return { type: "parseError", raw, error: e.message };
    }
  }

  return { type: "plain", text: trimmed };
}

export function encodeDecision(id, decision) {
  return `${MARKERS.decision} ${JSON.stringify({ id, decision })}\n`;
}

/** argv for the agent call. TODO-VERIFY against `hermes chat --help`. */
export function buildArgv({ utterance, sessionId, argvTemplate }) {
  const tpl = argvTemplate && argvTemplate.length ? argvTemplate : ["chat", "-q", "{{utterance}}", "--session", "{{sessionId}}"];
  return tpl.map((part) => part.replaceAll("{{utterance}}", utterance).replaceAll("{{sessionId}}", sessionId));
}

/**
 * Incremental line splitter: feed raw stdout chunks, get complete lines back.
 * Never drops a trailing partial line — the caller must call .flush() at EOF.
 */
export function lineSplitter() {
  let buf = "";
  return {
    push(chunk) {
      buf += chunk;
      const out = [];
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        out.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
      return out;
    },
    flush() {
      const rest = buf;
      buf = "";
      return rest.trim() ? [rest] : [];
    },
  };
}
