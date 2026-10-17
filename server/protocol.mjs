// server/protocol.mjs — Hermes wire protocol (server side, v1.0).
// Supports both:
//   1. Real Hermes CLI `--format stream-json` line-delimited JSON objects:
//      • {"type":"system","subtype":"init","model":"...","session_id":"..."}
//      • {"type":"text","text":"..."}
//      • {"type":"tool_call","name":"...","arguments":{...},"id":"..."}
//      • {"type":"result","text":"...","exit_code":0}
//   2. Legacy HV_* marker-prefixed protocol:
//      • HV_EVENT:    {"kind":"thinking|toolCall|progress|completed|failed|cancelled", ...}
//      • HV_PERM:     {"tool":"shell","args":{...},"reason":"...","risk":"high"?, "id"?}
//      • HV_PROGRESS: <free text>
//   3. Unmarked plain text lines (graceful fallback)
//
// Decision written back to the child's stdin:
//   HV_DECISION: {"id":"<permId>","decision":"allowOnce|allowSession|deny"}

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

function normalizeArgs(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === "string") {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      return { raw: rawArgs };
    }
  }
  if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    const out = {};
    for (const [k, v] of Object.entries(rawArgs)) {
      out[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
    return out;
  }
  return {};
}

export function parseLine(line, taskID) {
  const trimmed = (line ?? "").replace(/\r$/, "").trim();
  if (!trimmed) return null;

  /* ------------------------ 1. Legacy HV_* markers ----------------------- */
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

  /* ------------------- 2. Hermes CLI `--format stream-json` -------------- */
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const o = JSON.parse(trimmed);
      if (o && typeof o === "object" && typeof o.type === "string") {
        switch (o.type) {
          case "system":
            return {
              type: "streamSystem",
              subtype: String(o.subtype ?? "init"),
              model: o.model ? String(o.model) : null,
              sessionId: o.session_id ? String(o.session_id) : null,
            };
          case "text":
          case "assistant":
          case "content_block_delta": {
            const text = String(o.text ?? o.delta?.text ?? o.content ?? "");
            return { type: "streamText", text };
          }
          case "tool_call":
          case "tool_use": {
            const toolName = String(o.name ?? o.tool ?? "unknown_tool");
            const args = normalizeArgs(o.arguments ?? o.args ?? o.input);
            const classified = classifyRisk(toolName, args);
            const risk = RISKS.includes(o.risk) ? o.risk : classified.risk;
            const id = String(o.id ?? o.tool_call_id ?? crypto.randomUUID());
            return {
              type: "streamToolCall",
              toolName,
              args,
              risk,
              request: {
                id,
                taskID,
                toolName,
                args,
                risk,
                reason: o.reason ?? classified.note,
              },
            };
          }
          case "result": {
            const exitCode = typeof o.exit_code === "number" ? o.exit_code : 0;
            const text = String(o.text ?? o.result ?? "");
            return {
              type: "streamResult",
              text,
              exitCode,
            };
          }
          case "error": {
            return {
              type: "event",
              event: { kind: "failed", taskID, reason: String(o.message ?? o.error ?? "stream-json error") },
            };
          }
        }
      }
    } catch {
      /* Not valid stream-json; fall through to plain text */
    }
  }

  /* ------------------------- 3. Plain text fallback ---------------------- */
  return { type: "plain", text: trimmed };
}

export function encodeDecision(id, decision) {
  return `${MARKERS.decision} ${JSON.stringify({ id, decision })}\n`;
}

/** argv for the agent call. Substitutes {{utterance}} and {{sessionId}}. */
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
