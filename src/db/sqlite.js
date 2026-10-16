// Adaptador SQLite (node:sqlite, Node >= 22.13) usado APENAS nos testes automáticos,
// para validar o SQL standard da semantic layer sem instalar dependências.
import { dialects } from './dialects.js';

export async function openSqlite() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
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
