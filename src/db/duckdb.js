// DuckDB adapter (@duckdb/node-api). All interaction with the driver is isolated here:
// if the driver API changes, only this file needs adjusting.
import { dialects } from './dialects.js';

/** Converts driver values (BigInt, DATE, TIMESTAMP...) to plain JS. */
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
 * Opens a DuckDB database. `path` = .duckdb file or ':memory:'. `readOnly` = read only (UI server).
 * Returns a minimal interface { dialect, exec, all, close } shared with the SQLite test adapter.
 */
export async function openDuckDb(path = ':memory:', { readOnly = false } = {}) {
  let api;
  try {
    api = await import('@duckdb/node-api');
  } catch (err) {
    throw new Error(
      'Could not load @duckdb/node-api. Run `npm install` first.\n' + `Detail: ${err.message}`,
    );
  }
  // READ_ONLY: several processes can read at the same time (UI server + queries), but none can write.
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
