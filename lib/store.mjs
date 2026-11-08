// Shared memory store: one SQLite file both agents read and write.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { MEMORY_DB } from "./config.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  created INTEGER NOT NULL,
  agent   TEXT,
  scope   TEXT,
  tags    TEXT,
  text    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_created ON memories(created);
CREATE INDEX IF NOT EXISTS idx_mem_scope   ON memories(scope);
`;

let db = null;

export function memory() {
  if (db) return db;
  fs.mkdirSync(path.dirname(MEMORY_DB), { recursive: true });
  db = new DatabaseSync(MEMORY_DB);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(SCHEMA);
  return db;
}

export function remember({ text, agent, scope, tags }) {
  if (!text || !String(text).trim()) throw new Error("text is required");
  const now = Date.now();
  const info = memory()
    .prepare(
      "INSERT INTO memories (created, agent, scope, tags, text) VALUES (?, ?, ?, ?, ?)"
    )
    .run(
      now,
      agent ?? null,
      scope ?? null,
      Array.isArray(tags) ? tags.join(",") : (tags ?? null),
      String(text).trim()
    );
  return { id: Number(info.lastInsertRowid), created: now };
}

export function recall({ query, tags, scope, limit = 10, sinceDays } = {}) {
  const where = [];
  const args = [];
  if (scope) {
    where.push("scope = ?");
    args.push(scope);
  }
  if (sinceDays) {
    where.push("created >= ?");
    args.push(Date.now() - sinceDays * 86_400_000);
  }
  if (tags) {
    const list = Array.isArray(tags) ? tags : String(tags).split(",");
    for (const t of list.map((s) => s.trim()).filter(Boolean)) {
      where.push("tags LIKE ?");
      args.push(`%${t}%`);
    }
  }

  const sql =
    "SELECT id, created, agent, scope, tags, text FROM memories" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY created DESC LIMIT 1000";
  let rows = memory().prepare(sql).all(...args);

  // Terms are matched in JS: predictable, no FTS dependency, fine for a
  // personal store. Score = how many distinct terms hit, tie-break newest.
  const terms = String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (terms.length) {
    const scored = [];
    for (const r of rows) {
      const hay = (r.text + " " + (r.tags ?? "") + " " + (r.scope ?? "")).toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score++;
      if (score > 0) scored.push({ r, score });
    }
    scored.sort((a, b) => b.score - a.score || b.r.created - a.r.created);
    rows = scored.map((s) => s.r);
  }

  return rows.slice(0, Math.max(1, Math.min(100, limit)));
}

export function forget(id) {
  const info = memory().prepare("DELETE FROM memories WHERE id = ?").run(Number(id));
  return Number(info.changes) > 0;
}

export function stats() {
  const row = memory()
    .prepare("SELECT COUNT(*) c, MIN(created) first, MAX(created) last FROM memories")
    .get();
  return row;
}
