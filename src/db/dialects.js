// Camada de dialeto: tudo o que é específico de um motor SQL fica aqui.
// O resto do código (semantic layer, métricas) usa só SQL standard.
// Migração DuckDB -> ClickHouse = acrescentar um dialeto, não reescrever métricas.

export const duckdb = {
  name: 'duckdb',
  /** Converte a coluna de business date para DATE. */
  castDate(expr, format) {
    return format ? `CAST(strptime(${expr}, '${format.replace(/'/g, "''")}') AS DATE)` : `CAST(${expr} AS DATE)`;
  },
  castText(expr) {
    return `CAST(${expr} AS VARCHAR)`;
  },
  /** Agregação de strings ordenada (LISTAGG). */
  stringAgg(expr, sep, orderExpr) {
    return `string_agg(${expr}, '${sep}' ORDER BY ${orderExpr})`;
  },
  /** Fonte Parquet. */
  parquetSource(glob) {
    return `read_parquet('${glob.replace(/'/g, "''")}', union_by_name = true)`;
  },
  /** true se o texto inteiro casa com a regex (sintaxe RE2). ClickHouse: match(expr, '^(?:...)$'). */
  regexFull(expr, pattern) {
    return `regexp_full_match(${expr}, '${pattern.replace(/'/g, "''")}')`;
  },
  castNumber(expr) {
    return `CAST(${expr} AS DOUBLE)`;
  },
};

// Só para testes automáticos (node:sqlite), sem dependências externas.
export const sqlite = {
  name: 'sqlite',
  castDate(expr) {
    return expr;
  },
  castText(expr) {
    return `CAST(${expr} AS TEXT)`;
  },
  stringAgg(expr, sep) {
    // A ordenação é garantida pela subquery que alimenta o group_concat (ver analysis/profile.js).
    return `group_concat(${expr}, '${sep}')`;
  },
  parquetSource() {
    throw new Error('SQLite não lê Parquet; usado apenas em testes com tabelas em memória.');
  },
  /** Função regexp_full_match registada pelo adaptador (src/db/sqlite.js), com o mesmo nome do DuckDB. */
  regexFull(expr, pattern) {
    return `regexp_full_match(${expr}, '${pattern.replace(/'/g, "''")}')`;
  },
  castNumber(expr) {
    return `CAST(${expr} AS REAL)`;
  },
};

export const dialects = { duckdb, sqlite };
