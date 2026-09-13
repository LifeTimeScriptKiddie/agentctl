import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionRecordSchema, type SessionRecord, type SessionTurn } from '../schema/session.js';
import { agentctlHome } from './agentHome.js';

/** Root for persisted chat sessions: ~/.agentctl/sessions (override via AGENTCTL_HOME). */
export function sessionsDir(): string {
  return join(agentctlHome(), 'sessions');
}

export function sessionPath(id: string): string {
  return join(sessionsDir(), `${id}.json`);
}

/** A fresh, empty session. `now` is injectable so callers/tests stay deterministic. */
export function newSession(now: number, id: string = randomUUID().slice(0, 8)): SessionRecord {
  return { id, createdAt: now, updatedAt: now, native: {}, transcript: [] };
}

/** Load a session by id, or null if it doesn't exist. Throws on corrupt files (fail-closed). */
export function loadSession(id: string): SessionRecord | null {
  const path = sessionPath(id);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const parsed = SessionRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`corrupt session file ${path}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  return parsed.data;
}

/** Atomic write (temp + rename) so a crash can't leave a half-written session. */
export function saveSession(rec: SessionRecord, now: number): void {
  const path = sessionPath(rec.id);
  mkdirSync(sessionsDir(), { recursive: true });
  const withStamp = { ...rec, updatedAt: now };
  // unique tmp per writer so two processes persisting the same id can't splice
  // their JSON into a shared temp file before the atomic rename.
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(withStamp, null, 2), 'utf8');
  renameSync(tmp, path);
}

/** Session ids on disk, most-recently-updated first (for `--resume`). */
export function listSessions(): SessionRecord[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const recs: SessionRecord[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = loadSession(f.slice(0, -'.json'.length));
      if (rec) recs.push(rec);
    } catch {
      /* skip corrupt */
    }
  }
  return recs.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The most recently updated session, or null. */
export function latestSession(): SessionRecord | null {
  return listSessions()[0] ?? null;
}

/** Append a turn to a session's shared transcript (pure; returns a new record). */
export function addTurn(rec: SessionRecord, turn: SessionTurn): SessionRecord {
  return { ...rec, transcript: [...rec.transcript, turn] };
}

/** Record an agent's native session id (pure; returns a new record). */
export function setNative(rec: SessionRecord, agent: string, sessionId: string): SessionRecord {
  return { ...rec, native: { ...rec.native, [agent]: sessionId } };
}

/** Delete a session by id. Returns true if a file was removed. */
export function deleteSession(id: string): boolean {
  const path = sessionPath(id);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/** Remove sessions not updated within `maxAgeMs`. Returns the ids removed. */
export function pruneSessions(maxAgeMs: number, now: number): string[] {
  const removed: string[] = [];
  for (const rec of listSessions()) {
    if (now - rec.updatedAt > maxAgeMs) {
      if (deleteSession(rec.id)) removed.push(rec.id);
    }
  }
  return removed;
}
