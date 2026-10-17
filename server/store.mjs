// server/store.mjs — local persistence: audit (append-only), sessions, read-only Hermes memory.
// Data root: ~/.hermes-voice  (or $HV_DATA_DIR). No cloud, no sync, no telemetry.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { AUDIT_FILE, SESSIONS_DIR, SCRATCH_DIR } from "./config.mjs";
import { redact, formatArgs, redactArgs } from "./redact.mjs";

const MAX_SESSIONS = 100;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

// Mutable roots so the self-test suite can point storage at a temp dir instead of
// polluting the real audit log. Production always uses ~/.hermes-voice.
let ROOTS = { audit: AUDIT_FILE, sessions: SESSIONS_DIR, scratch: SCRATCH_DIR };

export const roots = () => ({ ...ROOTS });

export function __setTestRoots(dir) {
  ROOTS = dir
    ? { audit: join(dir, "audit.jsonl"), sessions: join(dir, "sessions"), scratch: join(dir, "scratch") }
    : { audit: AUDIT_FILE, sessions: SESSIONS_DIR, scratch: SCRATCH_DIR };
  return roots();
}

/* --------------------------------- audit -------------------------------- */

export function appendAudit(entry, { redactEnabled = true } = {}) {
  mkdirSync(dirname(ROOTS.audit), { recursive: true });
  const row = {
    id: entry.id ?? crypto.randomUUID(),
    at: entry.at ?? Date.now(),
    taskId: entry.taskId ?? null,
    tool: entry.tool,
    risk: entry.risk,
    decision: entry.decision,
    via: entry.via ?? "click",
    args: formatArgs(redactEnabled ? redactArgs(entry.args ?? {}) : entry.args ?? {}),
    reason: entry.reason ? (redactEnabled ? redact(entry.reason) : entry.reason) : null,
  };
  appendFileSync(ROOTS.audit, JSON.stringify(row) + "\n");
  return row;
}

export function listAudit(limit = 500) {
  if (!existsSync(ROOTS.audit)) return [];
  return readFileSync(ROOTS.audit, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(-limit)
    .reverse();
}

export function clearAudit() {
  if (existsSync(ROOTS.audit)) writeFileSync(ROOTS.audit, "");
}

/* -------------------------------- sessions ------------------------------- */

export function saveSession(session) {
  mkdirSync(ROOTS.sessions, { recursive: true });
  writeFileSync(join(ROOTS.sessions, `${session.id}.json`), JSON.stringify({ schemaVersion: 1, ...session }, null, 2));
  pruneSessions();
  return session;
}

export function listSessions() {
  if (!existsSync(ROOTS.sessions)) return [];
  const cutoff = Date.now() - MAX_AGE_MS;
  return readdirSync(ROOTS.sessions)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const s = JSON.parse(readFileSync(join(ROOTS.sessions, f), "utf8"));
        return s.startedAt >= cutoff ? s : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_SESSIONS);
}

export function getSession(id) {
  const p = join(ROOTS.sessions, `${String(id).replace(/[^a-z0-9-]/gi, "")}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

/** Retention: newest 100 sessions, nothing older than 30 days. */
export function pruneSessions() {
  if (!existsSync(ROOTS.sessions)) return 0;
  const cutoff = Date.now() - MAX_AGE_MS;
  const byAge = readdirSync(ROOTS.sessions)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ f, m: statSync(join(ROOTS.sessions, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  let removed = 0;
  byAge.forEach((entry, i) => {
    if (i >= MAX_SESSIONS || entry.m < cutoff) {
      rmSync(join(ROOTS.sessions, entry.f), { force: true });
      removed++;
    }
  });
  return removed;
}

export function deleteAllSessions() {
  if (existsSync(ROOTS.sessions)) rmSync(ROOTS.sessions, { recursive: true, force: true });
  mkdirSync(ROOTS.sessions, { recursive: true });
}

/* --------------------------- Hermes memory (read-only) ------------------- */

const MEMORIES_ROOT = join(homedir(), ".hermes", "memories");

/** Strict path jail: only files under ~/.hermes/memories, max 512 KB, never written. */
export function readMemoryFile(relPath, root = MEMORIES_ROOT) {
  const base = resolve(root);
  const target = resolve(base, relPath);
  if (!target.startsWith(base + "/") && target !== base) {
    throw Object.assign(new Error(`path escapes ${root}`), { status: 400 });
  }
  if (!existsSync(target)) throw Object.assign(new Error(`no such memory file: ${relPath}`), { status: 404 });
  const st = statSync(target);
  if (!st.isFile()) throw Object.assign(new Error("not a file"), { status: 400 });
  if (st.size > 512 * 1024) throw Object.assign(new Error("file too large (>512KB)"), { status: 413 });
  return { path: relPath, bytes: st.size, mtime: st.mtimeMs, text: readFileSync(target, "utf8"), readOnly: true };
}

export function listMemoryFiles(root = MEMORIES_ROOT) {
  if (!existsSync(root)) return { root, files: [], available: false, note: "~/.hermes/memories not present on this host" };
  const walk = (dir, prefix = "") => {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && rel.split("/").length < 4) out.push(...walk(join(dir, entry.name), rel));
      else if (entry.isFile() && /\.(md|txt|json)$/i.test(entry.name)) out.push(rel);
    }
    return out;
  };
  return { root, files: walk(root).slice(0, 200), available: true };
}

/* --------------------------------- scratch -------------------------------- */

/** Delete TTS/debug artefacts older than 24h (spec §12.3). */
export function cleanScratch(maxAgeMs = 24 * 3600 * 1000, dir = ROOTS.scratch) {
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let n = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    try {
      if (statSync(p).mtimeMs < cutoff) {
        rmSync(p, { force: true });
        n++;
      }
    } catch {
      /* ignore */
    }
  }
  return n;
}
