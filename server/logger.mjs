// server/logger.mjs — structured logs, redaction at the sink, ring buffer + file mirror.
// Native equivalent: os.Logger + ~/Library/Logs/HermesVoice (spec §6.12).

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./redact.mjs";
import { LOG_DIR } from "./config.mjs";

const RANK = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger {
  constructor({ level = "info", redactEnabled = true } = {}) {
    this.level = level;
    this.redactEnabled = redactEnabled;
    this.buffer = [];
    this.listeners = new Set();
    this.file = join(LOG_DIR, `hermes-voice-${new Date().toISOString().slice(0, 10)}.log`);
  }

  configure({ level, redactEnabled }) {
    if (level) this.level = level;
    if (typeof redactEnabled === "boolean") this.redactEnabled = redactEnabled;
  }

  write(category, level, message, meta) {
    if (RANK[level] < RANK[this.level]) return;
    const text = this.redactEnabled ? redact(String(message)) : String(message);
    const line = { id: crypto.randomUUID(), at: Date.now(), level, category, message: text, meta: meta ?? null };
    this.buffer.push(line);
    if (this.buffer.length > 500) this.buffer.splice(0, this.buffer.length - 500);
    for (const l of this.listeners) {
      try {
        l(line);
      } catch {
        /* a dead SSE client must not break logging */
      }
    }
    try {
      appendFileSync(this.file, `${new Date(line.at).toISOString()} [${level.toUpperCase()}] ${category}: ${text}\n`);
    } catch {
      /* log file failure is never fatal */
    }
  }

  debug(c, m, x) { this.write(c, "debug", m, x); }
  info(c, m, x) { this.write(c, "info", m, x); }
  warn(c, m, x) { this.write(c, "warn", m, x); }
  error(c, m, x) { this.write(c, "error", m, x); }

  tail(n = 200, minLevel = "debug") {
    return this.buffer.filter((l) => RANK[l.level] >= RANK[minLevel]).slice(-n).reverse();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  exportText() {
    return this.buffer.map((l) => `${new Date(l.at).toISOString()} [${l.level.toUpperCase()}] ${l.category}: ${l.message}`).join("\n");
  }
}
