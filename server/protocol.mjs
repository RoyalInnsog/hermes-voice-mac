// server/protocol.mjs — Hermes Voice v1.0 wire protocol parser.
// Supports BOTH:
//   1. Real Hermes CLI `--format stream-json` line-delimited JSON chunks:
//        {"type": "system", "subtype": "init", "model": "...", "session_id": "..."}
//        {"type": "text", "text": "..."}
//        {"type": "tool_call", "name": "...", "arguments": {...}, "id"?: "..."}
//        {"type": "result", "text": "...", "exit_code": 0}
//   2. Legacy HV_* markers:
//        HV_EVENT:    {"kind":"thinking|toolCall|progress|completed|failed|cancelled", ...}
//        HV_PERM:     {"tool":"shell","args":{...},"reason":"...","risk"?,"id"?}
//        HV_PROGRESS: <free text>
//   3. Plain text stdout fallback (any unmarked non-JSON line).
//
// Decision written back to child stdin:
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
      if (parsed && typeof parsed === "object") {
        return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
      }
    } catch {
      return { raw: rawArgs };
    }
  }
  if (typeof rawArgs === "object") {
    return Object.fromEntries(Object.entries(rawArgs).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  }
  return {};
}

export function parseLine(line, taskID) {
  const trimmed = (line ?? "").replace(/\r$/, "").trim();
  if (!trimmed) return null;

  /* 1. Legacy HV_PROGRESS marker */
  if (trimmed.startsWith(MARKERS.progress)) {
    return { type: "progress", text: trimmed.slice(MARKERS.progress.length).trim() };
  }

  /* 2. Legacy HV_PERM marker */
  if (trimmed.startsWith(MARKERS.perm)) {
    const raw = trimmed.slice(MARKERS.perm.length).trim();
    try {
      const o = JSON.parse(raw);
      const toolName = String(o.tool ?? "unknown_tool");
      const args = normalizeArgs(o.args);
      const classified = classifyRisk(toolName, args);
      const risk = RISKS.includes(o.risk) ? o.risk : classified.risk;
      return {
        type: "permission",
        request: {
          id: String(o.id ?? crypto.randomUUID()),
          taskID,
          toolName,
          args,
          risk,
          reason: o.reason ?? classified.note,
        },
      };
    } catch (e) {
      return { type: "parseError", raw, error: e.message };
    }
  }

  /* 3. Legacy HV_EVENT marker */
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
          return { type: "event", event: { kind, taskID, name: String(o.name ?? "tool"), args: normalizeArgs(o.args) } };
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

  /* 4. Real Hermes CLI `--format stream-json` line-delimited JSON */
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && typeof obj.type === "string") {
        switch (obj.type) {
          case "system":
            return {
              type: "streamSystem",
              subtype: String(obj.subtype ?? "init"),
              model: obj.model ? String(obj.model) : null,
              sessionId: obj.session_id ? String(obj.session_id) : null,
            };
          case "text":
            return {
              type: "streamText",
              text: String(obj.text ?? obj.content ?? ""),
            };
          case "tool_call": {
            const toolName = String(obj.name ?? obj.tool ?? "unknown_tool");
            const args = normalizeArgs(obj.arguments ?? obj.args);
            const classified = classifyRisk(toolName, args);
            const risk = RISKS.includes(obj.risk) ? obj.risk : classified.risk;
            const requiresGate = obj.requires_permission !== false;
            return {
              type: "streamToolCall",
              requiresGate,
              request: {
                id: String(obj.id ?? crypto.randomUUID()),
                taskID,
                toolName,
                args,
                risk,
                reason: obj.reason ? String(obj.reason) : classified.note,
              },
            };
          }
          case "result": {
            const exitCode = typeof obj.exit_code === "number" ? obj.exit_code : 0;
            return {
              type: "streamResult",
              text: String(obj.text ?? obj.result ?? ""),
              exitCode,
              error: obj.error ? String(obj.error) : null,
            };
          }
        }
      }
    } catch {
      /* Not valid stream-json; fall through to plain text */
    }
  }

  return { type: "plain", text: trimmed };
}

export function encodeDecision(id, decision) {
  return `${MARKERS.decision} ${JSON.stringify({ id, decision })}\n`;
}

/**
 * Default v1.0 argv invokes:
 *   hermes chat -q "<utterance>" --format stream-json
 */
export function buildArgv({ utterance, sessionId, argvTemplate }) {
  const tpl =
    argvTemplate && argvTemplate.length
      ? argvTemplate
      : ["chat", "-q", "{{utterance}}", "--format", "stream-json"];
  return tpl.map((part) => part.replaceAll("{{utterance}}", utterance).replaceAll("{{sessionId}}", sessionId ?? ""));
}

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
