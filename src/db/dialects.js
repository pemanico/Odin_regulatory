// Dialect layer: everything specific to one SQL engine lives here.
// The rest of the code (semantic layer, metrics) uses standard SQL only.
// Migrating DuckDB -> ClickHouse = adding a dialect, not rewriting metrics.

export const duckdb = {
  name: 'duckdb',
  /** Converts the business date column to DATE. */
  castDate(expr, format) {
    return format ? `CAST(strptime(${expr}, '${format.replace(/'/g, "''")}') AS DATE)` : `CAST(${expr} AS DATE)`;
  },
  castText(expr) {
    return `CAST(${expr} AS VARCHAR)`;
  },
  /** Ordered string aggregation (LISTAGG). */
  stringAgg(expr, sep, orderExpr) {
    return `string_agg(${expr}, '${sep}' ORDER BY ${orderExpr})`;
  },
  /** Parquet source. */
  parquetSource(glob) {
    return `read_parquet('${glob.replace(/'/g, "''")}', union_by_name = true)`;
  },
  /** true if the whole text matches the regex (RE2 syntax). ClickHouse: match(expr, '^(?:...)$'). */
  regexFull(expr, pattern) {
    return `regexp_full_match(${expr}, '${pattern.replace(/'/g, "''")}')`;
  },
  castNumber(expr) {
    return `CAST(${expr} AS DOUBLE)`;
  },
};

// Automated tests only (node:sqlite), no external dependencies.
export const sqlite = {
  name: 'sqlite',
  castDate(expr) {
    return expr;
  },
  castText(expr) {
    return `CAST(${expr} AS TEXT)`;
  },
  stringAgg(expr, sep) {
    // Ordering is guaranteed by the subquery feeding group_concat (see analysis/profile.js).
    return `group_concat(${expr}, '${sep}')`;
  },
  parquetSource() {
    throw new Error('SQLite does not read Parquet; used only in tests with in-memory tables.');
  },
  /** regexp_full_match function registered by the adapter (src/db/sqlite.js), with the same name as in DuckDB. */
  regexFull(expr, pattern) {
    return `regexp_full_match(${expr}, '${pattern.replace(/'/g, "''")}')`;
  },
  castNumber(expr) {
    return `CAST(${expr} AS REAL)`;
  },
};

export const dialects = { duckdb, sqlite };
