// server/agent.mjs — the real Agent Bridge (spec §6.5, v1.0).
//
// Spawns the Hermes CLI (`hermes chat -q "<utterance>" --format stream-json`),
// parses both stream-json and HV_* wire protocols, streams AgentEvents over SSE,
// holds permission requests while Hermes CLI waits on stdin, writes HV_DECISION
// directly to child stdin (no SIGSTOP to prevent thread/pipe deadlocks), and
// enforces process-group termination (SIGTERM -> 5s -> SIGKILL) on cancel/timeout.

import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { DEFAULT_HERMES_PATHS } from "./config.mjs";
import { buildArgv, encodeDecision, lineSplitter, parseLine } from "./protocol.mjs";
import { canAutoApprove, classifyRisk } from "./risk.mjs";
import { redact } from "./redact.mjs";
import { appendAudit, saveSession, getSession } from "./store.mjs";
import { synthesizeProgressPing } from "./tts.mjs";

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
    this._binary = null;
  }

  /* ------------------------------ discovery ----------------------------- */

  /** Probe the binary instead of assuming it exists (spec §18.14/§18.15). */
  async resolveBinary() {
    const cmd = this.config.hermes.command?.[0];
    if (!cmd) return { found: false, detail: "no command configured" };
    if (cmd.includes("/") || cmd.startsWith(".")) {
      return existsSync(cmd)
        ? { found: true, path: cmd, detail: "configured absolute path exists" }
        : { found: false, path: cmd, detail: "configured path does not exist" };
    }

    // 1. Check configured pathHints first (includes /Users/apple/.hermes/hermes-agent/.hermes/bin and ~/.local/bin)
    const hints = this.config.hermes.pathHint ?? DEFAULT_HERMES_PATHS;
    for (const dir of hints) {
      const p = `${dir}/${cmd}`;
      if (existsSync(p)) return { found: true, path: p, detail: `found in ${dir}` };
    }

    // 2. Check system PATH
    const found = await new Promise((res) => execFile("sh", ["-c", `command -v "${cmd}"`], (err, out) => res(err ? "" : out.trim())));
    if (found) return { found: true, path: found, detail: "resolved on PATH" };

    return { found: false, path: cmd, detail: `not on PATH; searched ${hints.join(", ") || "no extra dirs"}` };
  }

  /* -------------------------------- start -------------------------------- */

  async start({ utterance, sessionId, meta }) {
    const text = String(utterance ?? "").trim();
    if (!text) throw new TaskError(400, "emptyUtterance", "utterance is empty");
    if (text.length > 4000) throw new TaskError(413, "utteranceTooLong", "utterance longer than 4000 chars");
    const activeCount = [...this.tasks.values()].filter((t) => !["done", "failed", "cancelled"].includes(t.status)).length;
    if (activeCount >= this.config.maxConcurrentTasks) {
      throw new TaskError(429, "tooManyTasks", `hard cap of ${this.config.maxConcurrentTasks} concurrent tasks reached`, "Cancel a running task first");
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
    const argv = buildArgv({ utterance: text, sessionId: sid, argvTemplate: this.config.hermes.argvTemplate });

    const task = {
      id,
      sessionId: sid,
      utterance: text,
      meta: meta ?? null,
      model: null,
      status: "running",
      events: [],
      seq: 0,
      startedAt: Date.now(),
      lastOutputAt: Date.now(),
      pingCount: 0,
      pingInterval: null,
      finishedAt: null,
      plain: [],
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
        cwd: task.cwd && existsSync(task.cwd) ? task.cwd : undefined,
        env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      this.#fail(task, "hermesCrashed", `spawn failed: ${e.message}`);
      this.#finish(task);
      return this.#public(task);
    }

    const splitter = lineSplitter();
    task.child.stdout.setEncoding("utf8");
    task.child.stdout.on("data", (chunk) => {
      task.lastOutputAt = Date.now();
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
      // Graceful fallback (§10.1): no structured completed event → whole stdout is the answer.
      if (!task.events.some((e) => e.type === "completed" || e.type === "failed")) {
        const textOut = task.plain.join("\n").trim();
        if (code === 0 && textOut) {
          this.#emit(task, "completed", { text: textOut, degraded: "used accumulated stdout" });
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

    // Mid-task spoken progress ping:
    // If narrationMode is explicitly "direct" or "on_demand", skip automatic pings.
    // If progressPingMs is configured and narrationMode is "verbose" (or not explicitly silenced), emit pings.
    const progressPingMs = Number(this.config.hermes?.progressPingMs ?? 12000);
    const narrationMode = this.config.hermes?.narrationMode ?? "verbose";
    if (progressPingMs > 0 && narrationMode !== "direct" && narrationMode !== "on_demand") {
      const checkEvery = Math.min(1000, Math.max(100, Math.floor(progressPingMs / 3)));
      task.pingInterval = setInterval(async () => {
        if (task.status !== "running" || task.finishedAt) return;
        if (Date.now() - task.lastOutputAt < progressPingMs) return;
        task.lastOutputAt = Date.now();
        const pingIdx = task.pingCount++;
        const ping = await synthesizeProgressPing(
          {
            index: pingIdx,
            voice: this.config.tts?.voice ?? "hi-IN-MadhurNeural",
            rate: this.config.tts?.rate ?? "+0%",
            engine: this.config.tts?.engine ?? "auto",
          },
          this.log,
        );
        if (task.status !== "running" || task.finishedAt) return;
        this.#emit(task, "progressPing", {
          text: ping.text,
          audioUrl: ping.audioUrl,
          engine: ping.engine,
          cached: Boolean(ping.cached),
          pingIndex: pingIdx + 1,
        });
        this.#emit(task, "progress", {
          text: ping.text,
          audioUrl: ping.audioUrl,
          isPing: true,
        });
      }, checkEvery);
      task.pingInterval.unref?.();
    }

    // Per-task timeout → process-group SIGTERM -> 5s -> SIGKILL and report.
    task.timeout = setTimeout(() => {
      this.log.warn("agent", `task ${id.slice(0, 8)} exceeded ${this.config.hermes.timeoutSec}s — killing process group`);
      this.#kill(task);
      this.#fail(task, "hermesTimeout", `no completion within ${this.config.hermes.timeoutSec}s`, "Raise hermes.timeoutSec or shorten the task");
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
        if (parsed.model) task.model = parsed.model;
        this.#emit(task, "progress", {
          text: `Hermes stream-json initialized${parsed.model ? ` · model ${parsed.model}` : ""}`,
          subtype: parsed.subtype,
        });
        break;
      case "streamText":
        if (parsed.text) {
          task.plain.push(parsed.text);
          this.#emit(task, "progress", { text: parsed.text, stream: true });
        }
        break;
      case "streamToolCall":
        // In stream-json mode, intercept tool_call for permission gating if risk >= medium (or if low & autoApproveLowRisk is false)
        this.#handlePermission(task, parsed.request, { emitToolOnAllow: true });
        break;
      case "streamResult":
        if (parsed.exitCode === 0) {
          const finalText = parsed.text || task.plain.join("\n").trim() || "Task completed.";
          this.#emit(task, "completed", { text: finalText });
        } else {
          this.#fail(task, "agentReported", parsed.text || `Hermes exited with code ${parsed.exitCode}`);
        }
        break;
      case "event":
        if (parsed.event.kind === "toolCall") this.#emit(task, "toolCall", { name: parsed.event.name, args: parsed.event.args });
        else if (parsed.event.kind === "completed") this.#emit(task, "completed", { text: parsed.event.text });
        else if (parsed.event.kind === "failed") this.#fail(task, "agentReported", parsed.event.reason);
        else if (parsed.event.kind === "cancelled") this.#emit(task, "cancelled", {});
        else this.#emit(task, parsed.event.kind, {});
        break;
      case "permission":
        this.#handlePermission(task, parsed.request, { emitToolOnAllow: false });
        break;
      case "parseError":
        this.log.warn("agent", `unparseable HV line: ${redact(parsed.raw).slice(0, 160)} (${parsed.error})`);
        this.#emit(task, "progress", { text: `⚠︎ unparseable agent line (${parsed.error})`, parseError: true });
        break;
    }
  }

  #handlePermission(task, req, { emitToolOnAllow = false } = {}) {
    const timeoutSec = this.config.permissions.timeoutSec;
    const request = { ...req, requestedAt: Date.now(), expiresAt: Date.now() + timeoutSec * 1000, timeoutSec };

    // Policy gates run server-side too — the UI cannot be trusted to enforce them.
    if (task.allowlist.has(req.toolName) && req.risk !== "critical") {
      this.#emit(task, "permissionDecision", { requestId: req.id, tool: req.toolName, decision: "allowSession", via: "policy-allowlist" });
      this.#writeDecision(task, req.id, "allowSession");
      if (emitToolOnAllow) this.#emit(task, "toolCall", { name: req.toolName, args: req.args });
      appendAudit(
        { taskId: task.id, tool: req.toolName, risk: req.risk, decision: "allowSession", via: "policy", args: req.args, reason: req.reason },
        { redactEnabled: this.config.logging.redact },
      );
      return;
    }
    if (canAutoApprove(req.risk, this.config.permissions.autoApproveLowRisk)) {
      this.#emit(task, "permissionDecision", { requestId: req.id, tool: req.toolName, decision: "allowOnce", via: "policy-auto-low" });
      this.#writeDecision(task, req.id, "allowOnce");
      if (emitToolOnAllow) this.#emit(task, "toolCall", { name: req.toolName, args: req.args });
      appendAudit(
        { taskId: task.id, tool: req.toolName, risk: req.risk, decision: "allowOnce", via: "policy", args: req.args, reason: req.reason },
        { redactEnabled: this.config.logging.redact },
      );
      return;
    }

    task.status = "awaiting";
    this.#emit(task, "permissionRequest", { request });
    this.log.info("permissions", `ask ${req.toolName} [${req.risk}] task=${task.id.slice(0, 8)} timeout=${timeoutSec}s`);

    const timer = setTimeout(() => {
      if (!task.pending.has(req.id)) return;
      this.log.warn("permissions", `timeout ${req.toolName} → auto-deny`);
      this.#resolve(task, req, "deny", "timeout");
    }, timeoutSec * 1000);

    task.pending.set(req.id, { request, timer, emitToolOnAllow });
  }

  /**
   * Direct stdin write without SIGSTOP (prevents pipe/thread deadlocks since Hermes CLI
   * blocks natively on stdin while awaiting approval).
   */
  #writeDecision(task, permId, decision) {
    if (!task.child?.stdin?.writable) {
      this.log.warn("agent", "child stdin closed — decision cannot be delivered (LIMITATIONS L-2)");
      this.#emit(task, "progress", { text: "⚠︎ agent stdin already closed; decision not deliverable", warning: true });
      return false;
    }
    try {
      // Ensure child is not stopped before writing to stdin
      if (task.child.pid && process.platform !== "win32") {
        try {
          process.kill(-task.child.pid, "SIGCONT");
        } catch {
          /* ignore if not stopped or not group leader */
        }
      }
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
    if (!["allowOnce", "allowSession", "deny"].includes(decision)) throw new TaskError(400, "badDecision", `decision must be allowOnce|allowSession|deny`);

    // Server-side security invariants — never trust the client.
    if (decision !== "deny" && ["high", "critical"].includes(pending.request.risk) && via === "voice") {
      throw new TaskError(403, "voiceBlocked", `${pending.request.risk} risk cannot be approved by voice`);
    }
    if (pending.request.risk === "critical") {
      if (decision === "allowSession") throw new TaskError(403, "noSessionAllowlist", "critical tools can never be session-allowlisted");
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
    if (entry.emitToolOnAllow && (decision === "allowOnce" || decision === "allowSession")) {
      this.#emit(task, "toolCall", { name: request.toolName, args: request.args });
    }
    this.log.info("permissions", `${request.toolName} [${request.risk}] → ${decision} via ${via} (delivered=${delivered})`);
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
   * Process-group termination: SIGTERM -> 5s -> SIGKILL (spec §1.6).
   */
  #kill(task) {
    const c = task.child;
    if (!c || c.killed) return;
    const pid = c.pid;
    try {
      if (pid && process.platform !== "win32") {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          c.kill("SIGTERM");
        }
      } else {
        c.kill("SIGTERM");
      }
      const killTimer = setTimeout(() => {
        try {
          if (pid && process.platform !== "win32") {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              if (!c.killed) c.kill("SIGKILL");
            }
          } else if (!c.killed) {
            c.kill("SIGKILL");
          }
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
    if (task.pending.size) this.log.warn("permissions", `task ${task.id.slice(0, 8)} ended with ${task.pending.size} unanswered request(s) — dropped`);
    task.pending.clear();
    if (task.status === "awaiting") task.status = "running";
  }

  #finish(task) {
    if (task.finishedAt) return;
    clearTimeout(task.timeout);
    if (task.pingInterval) clearInterval(task.pingInterval);
    this.#clearPending(task);
    task.finishedAt = Date.now();
    const completedEvt = task.events.find((e) => e.type === "completed");
    if (completedEvt) {
      task.status = "done";
      task.summary = completedEvt.payload.text;
    } else if (!["done", "failed", "cancelled"].includes(task.status)) {
      task.status = task.events.some((e) => e.type === "failed") ? "failed" : "done";
      task.summary = task.plain.join("\n").trim() || (task.status === "done" ? "Task completed." : "Task failed.");
    }
    this.#emit(task, "exit", { status: task.status, durationMs: task.finishedAt - task.startedAt });
    this.#recordUtterance(task, null); // flush session
    this.log.info("agent", `task ${task.id.slice(0, 8)} ${task.status} in ${task.finishedAt - task.startedAt}ms`);
    const cleanupTimer = setTimeout(() => {
      if (["done", "failed", "cancelled"].includes(task.status)) this.tasks.delete(task.id);
    }, 10 * 60 * 1000);
    cleanupTimer.unref?.();
  }

  #recordUtterance(task, utterance) {
    const session = getSession(task.sessionId) ?? {
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
        session.utterances.push({ id: crypto.randomUUID(), timestamp: Date.now(), role: "assistant", text: final.payload.text, audioDuration: null, confidence: null });
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
      summary: task.summary ?? null,
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
    const running = [...this.tasks.values()].filter((t) => !["done", "failed", "cancelled"].includes(t.status)).length;
    return {
      live: running,
      total: this.tasks.size,
      cap: this.config.maxConcurrentTasks,
      awaitingPermission: [...this.tasks.values()].filter((t) => t.status === "awaiting").length,
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
