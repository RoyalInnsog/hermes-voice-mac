// server/agent.mjs — Hermes Voice v1.0 Agent Bridge & TaskManager (spec §6.5 & §2.1).
//
// Spawns the Hermes CLI (`hermes chat -q "<utterance>" --format stream-json`),
// parses both live stream-json events (`system`, `text`, `tool_call`, `result`)
// and HV_* wire markers (`HV_EVENT:`, `HV_PERM:`, `HV_PROGRESS:`), streams
// AgentEvents to subscribers over SSE, pauses on permission requests until a
// decision arrives, writes HV_DECISION back to child stdin, and resumes.
//
// Guards implemented here:
//   • max 10 concurrent tasks (HARD RULE §1.6 / §2.2.8)
//   • process-group termination (SIGTERM -> 5s -> SIGKILL) on timeout or cancel
//   • permission timeout -> auto-deny (never auto-approve above "low")
//   • critical risk requires typed confirmation "ALLOW" and blocks voice approval
//   • all logged text passes through the redactor
//   • nothing in this file touches OmniRoute

import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { buildArgv, encodeDecision, lineSplitter, parseLine } from "./protocol.mjs";
import { canAutoApprove, classifyRisk } from "./risk.mjs";
import { redact } from "./redact.mjs";
import { appendAudit, saveSession, getSession } from "./store.mjs";

export class TaskError extends Error {
  constructor(status, code, message, hint) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint ?? null;
  }
}

export class TaskManager {
  constructor({ config, log }) {
    this.config = config;
    this.log = log;
    this.tasks = new Map();
    this.subscribers = new Map(); // taskId -> Set<fn>
    this._lastModel = config.omniroute?.activeCombo || "KRITI / 9Router";
  }

  /* ------------------------------ discovery ----------------------------- */

  /** Probe the Hermes binary deterministically (spec §1.2 / §18.14). */
  async resolveBinary() {
    const cmd = this.config.hermes.command?.[0];
    if (!cmd) return { found: false, detail: "no command configured" };
    if (cmd.includes("/") || cmd.startsWith(".")) {
      return existsSync(cmd)
        ? { found: true, path: cmd, detail: "configured absolute path exists" }
        : { found: false, path: cmd, detail: "configured path does not exist" };
    }
    const hints = this.config.hermes.pathHint ?? [];
    for (const dir of hints) {
      const p = `${dir}/${cmd}`;
      if (existsSync(p)) {
        return { found: true, path: p, detail: `found in ${dir}` };
      }
    }
    const found = await new Promise((res) =>
      execFile("sh", ["-c", `command -v ${cmd}`], (err, out) => res(err ? "" : out.trim())),
    );
    if (found) return { found: true, path: found, detail: "resolved on PATH" };
    return {
      found: false,
      path: cmd,
      detail: `not on PATH; searched ${hints.join(", ") || "no extra dirs"}`,
    };
  }

  /* -------------------------------- start -------------------------------- */

  async start({ utterance, sessionId, meta }) {
    const text = String(utterance ?? "").trim();
    if (!text) throw new TaskError(400, "emptyUtterance", "utterance is empty");
    if (text.length > 4000) throw new TaskError(413, "utteranceTooLong", "utterance longer than 4000 chars");

    const liveCount = [...this.tasks.values()].filter(
      (t) => !["done", "failed", "cancelled"].includes(t.status),
    ).length;
    if (liveCount >= this.config.maxConcurrentTasks || this.tasks.size >= this.config.maxConcurrentTasks) {
      // Prune completed tasks first if only finished tasks are holding slots
      if (liveCount < this.config.maxConcurrentTasks) {
        for (const [tid, t] of this.tasks.entries()) {
          if (["done", "failed", "cancelled"].includes(t.status)) this.tasks.delete(tid);
        }
      }
      if (this.tasks.size >= this.config.maxConcurrentTasks) {
        throw new TaskError(
          429,
          "tooManyTasks",
          `hard cap of ${this.config.maxConcurrentTasks} concurrent tasks reached`,
          "Cancel a running task first",
        );
      }
    }

    const bin = await this.resolveBinary();
    if (!bin.found) {
      throw new TaskError(
        503,
        "hermesNotFound",
        `agent binary not found: ${bin.path}`,
        `${bin.detail}. Set hermes.command in ~/.hermes-voice/config.json or HV_HERMES_CMD`,
      );
    }

    const id = crypto.randomUUID();
    const sid = sessionId || crypto.randomUUID();
    const argv = buildArgv({
      utterance: text,
      sessionId: sid,
      argvTemplate: this.config.hermes.argvTemplate,
    });

    const task = {
      id,
      sessionId: sid,
      utterance: text,
      meta: meta ?? null,
      model: this._lastModel,
      status: "running",
      events: [],
      seq: 0,
      startedAt: Date.now(),
      finishedAt: null,
      plain: [],
      streamedText: [],
      stderr: "",
      pending: new Map(),
      allowlist: new Set(),
      child: null,
      argv: [bin.path, ...(this.config.hermes.command.slice(1) ?? []), ...argv],
      cwd: this.config.hermes.cwd,
    };
    this.tasks.set(id, task);
    this.log.info("agent", `spawn ${bin.path} ${argv.slice(0, 4).join(" ")}… (task ${id.slice(0, 8)})`);

    this.#emit(task, "thinking", {});

    const env = { ...process.env };
    const extra = (this.config.hermes.pathHint ?? []).join(":");
    if (extra) env.PATH = `${extra}:${env.PATH ?? ""}`;

    try {
      task.child = spawn(task.argv[0], task.argv.slice(1), {
        cwd: existsSync(task.cwd) ? task.cwd : undefined,
        env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      this.#fail(task, "hermesCrashed", `spawn failed: ${e.message}`);
      return this.#public(task);
    }

    const splitter = lineSplitter();
    task.child.stdout.setEncoding("utf8");
    task.child.stdout.on("data", (chunk) => {
      for (const line of splitter.push(chunk)) this.#handleLine(task, line);
    });
    task.child.stderr.setEncoding("utf8");
    task.child.stderr.on("data", (chunk) => {
      task.stderr = (task.stderr + chunk).slice(-4000);
      this.log.debug("agent", `stderr: ${redact(chunk).trim().slice(0, 200)}`);
    });
    task.child.on("error", (e) => this.#fail(task, "hermesCrashed", `process error: ${e.message}`));
    task.child.on("close", (code, signal) => {
      for (const line of splitter.flush()) this.#handleLine(task, line);
      if (task.status === "cancelled") return this.#finish(task);
      // Graceful fallback (§10.1): if no structured completed/failed event arrived, use accumulated text or raw stdout.
      if (!task.events.some((e) => e.type === "completed" || e.type === "failed")) {
        const textOut = (task.streamedText.length ? task.streamedText.join("\n") : task.plain.join("\n")).trim();
        if (code === 0 && textOut) {
          this.#emit(task, "completed", {
            text: textOut,
            degraded: task.streamedText.length ? undefined : "no HV_EVENT: marker — used raw stdout",
          });
        } else {
          this.#fail(
            task,
            code === 0 ? "parseFailed" : "hermesCrashed",
            `exit ${code}${signal ? ` (${signal})` : ""}${task.stderr ? `: ${redact(task.stderr).slice(-200)}` : ""}`,
          );
        }
      }
      this.#finish(task);
    });

    // Per-task timeout → process-group kill (SIGTERM -> 5s -> SIGKILL) and report.
    task.timeout = setTimeout(() => {
      this.log.warn("agent", `task ${id.slice(0, 8)} exceeded ${this.config.hermes.timeoutSec}s — killing process group`);
      this.#kill(task);
      this.#fail(
        task,
        "hermesTimeout",
        `no completion within ${this.config.hermes.timeoutSec}s`,
        "Raise hermes.timeoutSec or shorten the task",
      );
      this.#finish(task);
    }, this.config.hermes.timeoutSec * 1000);

    this.#recordUtterance(task, { role: "user", text });
    return this.#public(task);
  }

  /* ----------------------------- line handling ---------------------------- */

  #handleLine(task, line) {
    const parsed = parseLine(line, task.id);
    if (!parsed) return;
    switch (parsed.type) {
      case "plain":
        task.plain.push(parsed.text);
        this.#emit(task, "progress", { text: parsed.text, raw: true });
        break;
      case "progress":
        this.#emit(task, "progress", { text: parsed.text });
        break;
      case "streamSystem":
        if (parsed.model) {
          task.model = parsed.model;
          this._lastModel = parsed.model;
        }
        this.#emit(task, "status", {
          subtype: parsed.subtype,
          model: parsed.model ?? task.model,
          sessionId: parsed.sessionId ?? task.sessionId,
        });
        break;
      case "streamText":
        if (parsed.text) {
          task.streamedText.push(parsed.text);
          task.plain.push(parsed.text);
          this.#emit(task, "progress", { text: parsed.text, streamChunk: true });
        }
        break;
      case "streamToolCall":
        // Spec §2.1: intercept stream-json tool_call as permission request if risk >= medium
        if (parsed.risk === "low") {
          this.#emit(task, "toolCall", { name: parsed.toolName, args: parsed.args });
        } else {
          this.#handlePermission(task, { ...parsed.request, emitToolOnApprove: true });
        }
        break;
      case "streamResult":
        if (parsed.exitCode === 0) {
          const finalText =
            parsed.text ||
            task.streamedText.join("\n").trim() ||
            task.plain.join("\n").trim() ||
            "Task completed.";
          this.#emit(task, "completed", { text: finalText, exitCode: 0 });
        } else {
          this.#fail(
            task,
            "agentReported",
            parsed.error || parsed.text || `Hermes exited with code ${parsed.exitCode}`,
          );
        }
        break;
      case "event":
        if (parsed.event.kind === "toolCall") {
          this.#emit(task, "toolCall", { name: parsed.event.name, args: parsed.event.args });
        } else if (parsed.event.kind === "completed") {
          this.#emit(task, "completed", { text: parsed.event.text });
        } else if (parsed.event.kind === "failed") {
          this.#fail(task, "agentReported", parsed.event.reason);
        } else if (parsed.event.kind === "cancelled") {
          this.#emit(task, "cancelled", {});
        } else {
          this.#emit(task, parsed.event.kind, {});
        }
        break;
      case "permission":
        this.#handlePermission(task, parsed.request);
        break;
      case "parseError":
        this.log.warn("agent", `unparseable HV line: ${redact(parsed.raw).slice(0, 160)} (${parsed.error})`);
        this.#emit(task, "progress", { text: `⚠︎ unparseable agent line (${parsed.error})`, parseError: true });
        break;
    }
  }

  #handlePermission(task, req) {
    const timeoutSec = this.config.permissions.timeoutSec;
    const request = {
      ...req,
      requestedAt: Date.now(),
      expiresAt: Date.now() + timeoutSec * 1000,
      timeoutSec,
    };

    // Policy gates run server-side too — the UI cannot be trusted to enforce them.
    if (task.allowlist.has(req.toolName) && req.risk !== "critical") {
      this.#emit(task, "permissionDecision", {
        requestId: req.id,
        tool: req.toolName,
        decision: "allowSession",
        via: "policy-allowlist",
      });
      this.#writeDecision(task, req.id, "allowSession");
      if (req.emitToolOnApprove) {
        this.#emit(task, "toolCall", { name: req.toolName, args: req.args });
      }
      appendAudit(
        {
          taskId: task.id,
          tool: req.toolName,
          risk: req.risk,
          decision: "allowSession",
          via: "policy",
          args: req.args,
          reason: req.reason,
        },
        { redactEnabled: this.config.logging.redact },
      );
      return;
    }
    if (canAutoApprove(req.risk, this.config.permissions.autoApproveLowRisk)) {
      this.#emit(task, "permissionDecision", {
        requestId: req.id,
        tool: req.toolName,
        decision: "allowOnce",
        via: "policy-auto-low",
      });
      this.#writeDecision(task, req.id, "allowOnce");
      if (req.emitToolOnApprove) {
        this.#emit(task, "toolCall", { name: req.toolName, args: req.args });
      }
      appendAudit(
        {
          taskId: task.id,
          tool: req.toolName,
          risk: req.risk,
          decision: "allowOnce",
          via: "policy",
          args: req.args,
          reason: req.reason,
        },
        { redactEnabled: this.config.logging.redact },
      );
      return;
    }

    task.status = "awaiting";
    this.#emit(task, "permissionRequest", { request });
    this.log.info(
      "permissions",
      `ask ${req.toolName} [${req.risk}] task=${task.id.slice(0, 8)} timeout=${timeoutSec}s`,
    );

    const timer = setTimeout(() => {
      if (!task.pending.has(req.id)) return;
      this.log.warn("permissions", `timeout ${req.toolName} → auto-deny`);
      this.#resolve(task, request, "deny", "timeout");
    }, timeoutSec * 1000);

    task.pending.set(req.id, { request, timer, resolve: null });
  }

  #writeDecision(task, permId, decision) {
    if (!task.child?.stdin?.writable) {
      this.log.warn("agent", "child stdin closed — decision cannot be delivered (LIMITATIONS L-2)");
      this.#emit(task, "progress", { text: "⚠︎ agent stdin already closed; decision not deliverable", warning: true });
      return false;
    }
    try {
      task.child.stdin.write(encodeDecision(permId, decision));
      return true;
    } catch (e) {
      this.log.error("agent", `stdin write failed: ${e.message}`);
      return false;
    }
  }

  /** Decision from the UI (click / voice / typed confirmation). */
  decide({ taskId, requestId, decision, via = "click", typedConfirm = null }) {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskError(404, "taskNotFound", `no such task: ${taskId}`);
    const pending = task.pending.get(requestId);
    if (!pending) throw new TaskError(409, "requestNotPending", `permission ${requestId} is not awaiting a decision`);
    if (!["allowOnce", "allowSession", "deny"].includes(decision)) {
      throw new TaskError(400, "badDecision", "decision must be allowOnce|allowSession|deny");
    }

    // Server-side security invariants — never trust the client.
    if (decision !== "deny" && ["high", "critical"].includes(pending.request.risk) && via === "voice") {
      throw new TaskError(403, "voiceBlocked", `${pending.request.risk} risk cannot be approved by voice`);
    }
    if (pending.request.risk === "critical") {
      if (decision === "allowSession") {
        throw new TaskError(403, "noSessionAllowlist", "critical tools can never be session-allowlisted");
      }
      if (decision !== "deny" && typedConfirm !== "ALLOW") {
        throw new TaskError(403, "typedConfirmRequired", "critical risk requires typed confirmation ALLOW");
      }
    }
    return this.#resolve(task, pending.request, decision, via);
  }

  #resolve(task, request, decision, via) {
    const entry = task.pending.get(request.id);
    if (!entry) return null;
    clearTimeout(entry.timer);
    task.pending.delete(request.id);
    if (decision === "allowSession") task.allowlist.add(request.toolName);
    task.status = task.pending.size ? "awaiting" : "running";

    const delivered = this.#writeDecision(task, request.id, decision);
    const auditRow = appendAudit(
      {
        taskId: task.id,
        tool: request.toolName,
        risk: request.risk,
        decision: via === "timeout" ? "timeout-deny" : decision,
        via,
        args: request.args,
        reason: request.reason,
      },
      { redactEnabled: this.config.logging.redact },
    );
    this.#emit(task, "permissionDecision", {
      requestId: request.id,
      tool: request.toolName,
      risk: request.risk,
      decision: via === "timeout" ? "timeout-deny" : decision,
      via,
      deliveredToAgent: delivered,
      auditId: auditRow.id,
    });
    if (request.emitToolOnApprove && (decision === "allowOnce" || decision === "allowSession")) {
      this.#emit(task, "toolCall", { name: request.toolName, args: request.args });
    }
    this.log.info(
      "permissions",
      `${request.toolName} [${request.risk}] → ${decision} via ${via} (delivered=${delivered})`,
    );
    return { decision, via, deliveredToAgent: delivered };
  }

  /* -------------------------------- cancel ------------------------------- */

  cancel(id) {
    const task = this.tasks.get(id);
    if (!task) throw new TaskError(404, "taskNotFound", `no such task: ${id}`);
    if (["done", "failed", "cancelled"].includes(task.status)) return { already: true, status: task.status };
    task.status = "cancelled";
    for (const [, entry] of task.pending) this.#resolve(task, entry.request, "deny", "cancel");
    this.#kill(task);
    this.#emit(task, "cancelled", {});
    this.#finish(task);
    return { cancelled: true };
  }

  /**
   * Process-group termination (spec §1.6): SIGTERM -> 5s -> SIGKILL.
   */
  #kill(task) {
    const c = task.child;
    if (!c || c.killed) return;
    const sendSignal = (sig) => {
      try {
        if (c.pid && process.platform !== "win32") {
          process.kill(-c.pid, sig);
        }
      } catch {
        /* process group already exited */
      }
      try {
        c.kill(sig);
      } catch {
        /* child already exited */
      }
    };
    try {
      sendSignal("SIGTERM");
      const killTimer = setTimeout(() => {
        try {
          if (!c.killed && c.exitCode === null) sendSignal("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 5000);
      killTimer.unref?.();
    } catch (e) {
      this.log.error("agent", `kill failed: ${e.message}`);
    }
  }

  /* ------------------------------- lifecycle ----------------------------- */

  #fail(task, code, message, hint) {
    this.#emit(task, "failed", { code, reason: redact(message), hint: hint ?? null });
    this.log.error("agent", `${code}: ${redact(message)}`);
  }

  /** Drop every outstanding permission timer so a finished task can never act later. */
  #clearPending(task) {
    for (const [, entry] of task.pending) clearTimeout(entry.timer);
    if (task.pending.size) {
      this.log.warn(
        "permissions",
        `task ${task.id.slice(0, 8)} ended with ${task.pending.size} unanswered request(s) — dropped`,
      );
    }
    task.pending.clear();
    if (task.status === "awaiting") task.status = "running";
  }

  #finish(task) {
    clearTimeout(task.timeout);
    this.#clearPending(task);
    task.finishedAt = Date.now();
    if (!["done", "failed", "cancelled"].includes(task.status)) {
      task.status = task.events.some((e) => e.type === "failed") ? "failed" : "done";
    }
    this.#emit(task, "exit", { status: task.status, durationMs: task.finishedAt - task.startedAt });
    this.#recordUtterance(task, null); // flush session
    this.log.info("agent", `task ${task.id.slice(0, 8)} ${task.status} in ${task.finishedAt - task.startedAt}ms`);
    // Drop finished tasks after 10 minutes so memory stays bounded.
    const cleanupTimer = setTimeout(() => {
      if (["done", "failed", "cancelled"].includes(task.status)) this.tasks.delete(task.id);
    }, 10 * 60 * 1000);
    cleanupTimer.unref?.();
  }

  #recordUtterance(task, utterance) {
    let session = getSession(task.sessionId) ?? {
      id: task.sessionId,
      startedAt: task.startedAt,
      endedAt: null,
      status: "active",
      utterances: [],
    };
    if (utterance) {
      session.utterances.push({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        ...utterance,
        audioDuration: utterance.audioDuration ?? null,
        confidence: utterance.confidence ?? null,
      });
    } else {
      const final = task.events.find((e) => e.type === "completed");
      const failed = task.events.find((e) => e.type === "failed");
      if (final) {
        session.utterances.push({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          role: "assistant",
          text: final.payload.text,
          audioDuration: null,
          confidence: null,
        });
      } else if (failed) {
        session.utterances.push({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          role: "assistant",
          text: `[${failed.payload.code}] ${failed.payload.reason}`,
          audioDuration: null,
          confidence: null,
        });
      }
      session.endedAt = Date.now();
      session.status = task.status === "cancelled" ? "abandoned" : "completed";
    }
    try {
      saveSession(session);
    } catch (e) {
      this.log.error("app", `sessionSaveFailed: ${e.message}`);
    }
  }

  #emit(task, type, payload) {
    const evt = { seq: ++task.seq, at: Date.now(), taskId: task.id, type, payload };
    task.events.push(evt);
    if (task.events.length > 500) task.events.splice(0, task.events.length - 500);
    const subs = this.subscribers.get(task.id);
    if (subs) for (const fn of subs) fn(evt);
    if (type === "completed") this.log.info("agent", `completed: ${redact(payload.text).slice(0, 120)}`);
    return evt;
  }

  /* -------------------------------- views -------------------------------- */

  #public(task) {
    return {
      id: task.id,
      sessionId: task.sessionId,
      model: task.model,
      status: task.status,
      utterance: task.utterance,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      argv: task.argv,
      cwd: task.cwd,
      pending: [...task.pending.values()].map((p) => p.request),
      events: task.events,
      seq: task.seq,
    };
  }

  list() {
    return [...this.tasks.values()].map((t) => this.#public(t));
  }

  get(id) {
    const task = this.tasks.get(id);
    if (!task) throw new TaskError(404, "taskNotFound", `no such task: ${id}`);
    return this.#public(task);
  }

  eventsSince(id, seq) {
    const task = this.tasks.get(id);
    if (!task) throw new TaskError(404, "taskNotFound", `no such task: ${id}`);
    return task.events.filter((e) => e.seq > (seq ?? 0));
  }

  subscribe(id, fn) {
    const task = this.tasks.get(id);
    if (!task) throw new TaskError(404, "taskNotFound", `no such task: ${id}`);
    if (!this.subscribers.has(id)) this.subscribers.set(id, new Set());
    this.subscribers.get(id).add(fn);
    return () => {
      const s = this.subscribers.get(id);
      s?.delete(fn);
      if (s && s.size === 0) this.subscribers.delete(id);
    };
  }

  stats() {
    const running = [...this.tasks.values()].filter(
      (t) => !["done", "failed", "cancelled"].includes(t.status),
    ).length;
    return {
      live: running,
      total: this.tasks.size,
      cap: this.config.maxConcurrentTasks,
      awaitingPermission: [...this.tasks.values()].filter((t) => t.status === "awaiting").length,
      activeModel: this._lastModel,
    };
  }

  /** Kill every live child and clear every timer on shutdown — nothing orphaned. */
  shutdown() {
    for (const task of this.tasks.values()) {
      this.#clearPending(task);
      if (!["done", "failed", "cancelled"].includes(task.status)) this.#kill(task);
    }
    this.subscribers.clear();
  }
}

export { classifyRisk };
