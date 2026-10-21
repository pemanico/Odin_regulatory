#!/usr/bin/env node
// Builds the local DuckDB database from the breaks Parquet files:
//   breaks_raw = raw rows, with logical names
//   breaks     = deduplicated view (1 row per break)
// Usage: npm run build:db [-- --glob "data/breaks/*.parquet"] [--views]
// WARNING: deletes and recreates the database file, including the rules engine tables (run npm run rules again).
import * as fs from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDuckDb } from '../src/db/duckdb.js';
import { buildModelStatements } from '../src/db/model.js';
import { parseArgs } from '../src/cli.js';

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(args.glob ? { source: { breaksGlob: args.glob } } : {});
const { breaksGlob, dbPath } = config.source;

// fs.globSync exists from Node 22; on Node 20 DuckDB validates the glob on its own.
const files = fs.globSync ? fs.globSync(breaksGlob) : null;
if (files && files.length === 0) {
  console.error(`No Parquet files found in: ${breaksGlob}`);
  console.error('Adjust ODIN_BREAKS_GLOB in .env or generate synthetic data with `npm run synthetic`.');
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
  console.log(`Database created at ${dbPath} (${((Date.now() - t0) / 1000).toFixed(1)}s, ${files ? files.length : '?'} file(s))`);
  console.table([summary]);
} finally {
  await db.close();
}
