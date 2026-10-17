// Section 6.10 / 6.11 — local persistence (settings, sessions, audit log).
// Everything is local. No telemetry, no cloud, no sync (Section 12.6).

import { DEFAULT_SETTINGS, type AuditEntry, type Session, type Settings } from "./types";

const K_SETTINGS = "hv.settings.v1";
const K_SESSIONS = "hv.sessions.v1";
const K_AUDIT = "hv.audit.v1";

const MAX_SESSIONS = 100;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_AUDIT = 500;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------ settings -------------------------------- */

export function loadSettings(): Settings {
  const stored = read<Partial<Settings>>(K_SETTINGS, {});
  // Schema migration hook (Section 17). v1 is the only schema today.
  const merged: Settings = { ...DEFAULT_SETTINGS, ...stored, settingsSchemaVersion: 1 };
  return merged;
}

export function saveSettings(s: Settings): boolean {
  return write(K_SETTINGS, s);
}

/* ------------------------------ sessions -------------------------------- */

export function loadSessions(): Session[] {
  const all = read<Session[]>(K_SESSIONS, []);
  return prune(all);
}

export function saveSession(session: Session): boolean {
  const all = loadSessions().filter((s) => s.id !== session.id);
  all.unshift(session);
  return write(K_SESSIONS, prune(all));
}

export function deleteSessions(): boolean {
  return write(K_SESSIONS, []);
}

/** Retention: newest 100 sessions, nothing older than 30 days. */
export function prune(sessions: Session[]): Session[] {
  const cutoff = Date.now() - MAX_AGE_MS;
  return sessions
    .filter((s) => s.startedAt >= cutoff)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_SESSIONS);
}

/* ------------------------------- audit ---------------------------------- */

export function loadAudit(): AuditEntry[] {
  return read<AuditEntry[]>(K_AUDIT, []);
}

export function appendAudit(entry: AuditEntry): boolean {
  const all = loadAudit();
  all.unshift(entry);
  return write(K_AUDIT, all.slice(0, MAX_AUDIT));
}

export function clearAudit(): boolean {
  return write(K_AUDIT, []);
}

export function exportAudit(entries: AuditEntry[]): string {
  return entries
    .slice()
    .reverse()
    .map((e) => `${new Date(e.at).toISOString()}\t${e.risk.toUpperCase()}\t${e.toolName}\t${e.decision}\tvia=${e.via}\t${e.argsRedacted}`)
    .join("\n");
}
