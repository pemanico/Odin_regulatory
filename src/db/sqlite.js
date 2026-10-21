// SQLite adapter (node:sqlite, Node >= 22.13) used ONLY in the automated tests,
// to validate the semantic layer's standard SQL without installing dependencies.
import { dialects } from './dialects.js';

export async function openSqlite() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  // Same semantics as DuckDB's regexp_full_match (the whole text must match). NULL -> NULL.
  const cache = new Map();
  db.function('regexp_full_match', { deterministic: true }, (s, p) => {
    if (s == null || p == null) return null;
    if (!cache.has(p)) cache.set(p, new RegExp(`^(?:${p})$`));
    return cache.get(p).test(String(s)) ? 1 : 0;
  });
  return {
    dialect: dialects.sqlite,
    raw: db,
    async exec(sql) {
      db.exec(sql);
    },
    async all(sql) {
      return db.prepare(sql).all().map((r) => ({ ...r }));
    },
    async close() {
      db.close();
    },
  };
}

/** true if node:sqlite is available in this Node version. */
export async function sqliteAvailable() {
  try {
    await import('node:sqlite');
    return true;
  } catch {
    return false;
  }
}
