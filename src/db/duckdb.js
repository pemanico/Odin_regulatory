// Adaptador DuckDB (@duckdb/node-api). Toda a interação com o driver está isolada aqui:
// se a API do driver mudar, só este ficheiro precisa de ser ajustado.
import { dialects } from './dialects.js';

/** Converte valores do driver (BigInt, DATE, TIMESTAMP...) para JS simples. */
export function normalizeValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString();
  }
  if (typeof v === 'object') return String(v); // DuckDBDateValue, DuckDBTimestampValue, DECIMAL...
  return v;
}

function normalizeRows(rows) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, normalizeValue(v)])));
}

/**
 * Abre uma base DuckDB. `path` = ficheiro .duckdb ou ':memory:'. `readOnly` = só leitura (servidor da UI).
 * Devolve uma interface mínima { dialect, exec, all, close } partilhada com o adaptador SQLite de testes.
 */
export async function openDuckDb(path = ':memory:', { readOnly = false } = {}) {
  let api;
  try {
    api = await import('@duckdb/node-api');
  } catch (err) {
    throw new Error(
      'Não foi possível carregar @duckdb/node-api. Corre `npm install` primeiro.\n' + `Detalhe: ${err.message}`,
    );
  }
  // READ_ONLY: vários processos podem ler ao mesmo tempo (servidor da UI + consultas), mas nenhum pode escrever.
  const instance = await api.DuckDBInstance.create(path, readOnly ? { access_mode: 'READ_ONLY' } : undefined);
  const connection = await instance.connect();

  return {
    dialect: dialects.duckdb,
    async exec(sql) {
      await connection.run(sql);
    },
    async all(sql) {
      const reader = await connection.runAndReadAll(sql);
      return normalizeRows(reader.getRowObjects());
    },
    async close() {
      connection.closeSync?.();
      instance.closeSync?.();
    },
  };
}
