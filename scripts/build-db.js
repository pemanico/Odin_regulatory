#!/usr/bin/env node
// Constrói a base DuckDB local a partir dos Parquet de breaks:
//   breaks_raw = linhas brutas, com nomes lógicos
//   breaks     = vista deduplicada (1 linha por break)
// Uso: npm run build:db [-- --glob "data/breaks/*.parquet"] [--views]
import * as fs from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDuckDb } from '../src/db/duckdb.js';
import { buildModelStatements } from '../src/db/model.js';
import { parseArgs } from '../src/cli.js';

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(args.glob ? { source: { breaksGlob: args.glob } } : {});
const { breaksGlob, dbPath } = config.source;

// fs.globSync existe a partir do Node 22; no Node 20 o DuckDB valida o glob sozinho.
const files = fs.globSync ? fs.globSync(breaksGlob) : null;
if (files && files.length === 0) {
  console.error(`Nenhum ficheiro Parquet encontrado em: ${breaksGlob}`);
  console.error('Ajusta ODIN_BREAKS_GLOB no .env ou gera dados sintéticos com `npm run synthetic`.');
  process.exit(1);
}

fs.mkdirSync(dirname(dbPath), { recursive: true });
for (const f of [dbPath, `${dbPath}.wal`]) if (fs.existsSync(f)) fs.rmSync(f);

const db = await openDuckDb(dbPath);
const t0 = Date.now();
try {
  const statements = buildModelStatements(config, db.dialect, db.dialect.parquetSource(breaksGlob), {
    materialize: !args.views,
  });
  for (const sql of statements) await db.exec(sql);

  const [summary] = await db.all(`
    SELECT
      (SELECT COUNT(*) FROM breaks_raw) AS raw_rows,
      (SELECT COUNT(*) FROM breaks) AS distinct_breaks,
      (SELECT COUNT(DISTINCT business_date) FROM breaks) AS business_dates,
      (SELECT MIN(business_date) FROM breaks) AS first_date,
      (SELECT MAX(business_date) FROM breaks) AS last_date
  `);
  console.log(`Base criada em ${dbPath} (${((Date.now() - t0) / 1000).toFixed(1)}s, ${files ? files.length : '?'} ficheiro(s))`);
  console.table([summary]);
} finally {
  await db.close();
}
