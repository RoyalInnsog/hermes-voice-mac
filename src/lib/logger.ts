// Section 6.12 — logging with mandatory redaction at the sink.

import { redact } from "./redactor";
import type { LogLine, LogLevel } from "./types";
import { uid } from "./types";

type Listener = (line: LogLine) => void;

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger {
  private listeners = new Set<Listener>();
  private buffer: LogLine[] = [];
  minLevel: LogLevel = "debug";
  redactEnabled = true;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  lines(): LogLine[] {
    return this.buffer;
  }

  log(category: LogLine["category"], level: LogLevel, message: string) {
    if (RANK[level] < RANK[this.minLevel]) return;
    const line: LogLine = {
      id: uid(),
      at: Date.now(),
      level,
      category,
      message: this.redactEnabled ? redact(message) : message,
    };
    this.buffer = [line, ...this.buffer].slice(0, 400);
    this.listeners.forEach((l) => l(line));
  }

  debug(c: LogLine["category"], m: string) {
    this.log(c, "debug", m);
  }
  info(c: LogLine["category"], m: string) {
    this.log(c, "info", m);
  }
  warn(c: LogLine["category"], m: string) {
    this.log(c, "warn", m);
  }
  error(c: LogLine["category"], m: string) {
    this.log(c, "error", m);
  }

  export(): string {
    return this.buffer
      .slice()
      .reverse()
      .map((l) => `${new Date(l.at).toISOString()} [${l.level.toUpperCase()}] ${l.category}: ${l.message}`)
      .join("\n");
  }
}

export const logger = new Logger();
