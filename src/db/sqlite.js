// Adaptador SQLite (node:sqlite, Node >= 22.13) usado APENAS nos testes automáticos,
// para validar o SQL standard da semantic layer sem instalar dependências.
import { dialects } from './dialects.js';

export async function openSqlite() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  // Mesma semântica do regexp_full_match do DuckDB (o texto inteiro tem de casar). NULL -> NULL.
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

/** true se node:sqlite estiver disponível nesta versão do Node. */
export async function sqliteAvailable() {
  try {
    await import('node:sqlite');
    return true;
  } catch {
    return false;
  }
}
