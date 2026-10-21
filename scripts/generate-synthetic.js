#!/usr/bin/env node
// Generates synthetic breaks data (one file per business date) to develop without real data.
//
//   npm run synthetic -- [--days 4] [--positions 5000] [--start 2026-10-12] [--seed 42] [--out data/synthetic] [--keep-csv]
//
// Writes CSV and, if DuckDB is installed, converts it to Parquet.
// Then: ODIN_BREAKS_GLOB=data/synthetic/*.parquet npm run build:db
// Note: it does not generate a DTCC file, so npm run rules cannot run on synthetic data (CLAUDE.md, question 44).
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';
import { parseArgs } from '../src/cli.js';
import { generateBreakRows, toCsv } from '../src/synthetic/generate.js';

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();
const outDir = resolve(ROOT, args.out ?? 'data/synthetic');
mkdirSync(outDir, { recursive: true });

const { dates, rows } = generateBreakRows({
  columns: config.columns,
  startDate: args.start ?? '2026-10-12',
  days: Number(args.days ?? 4),
  positionsPerDay: Number(args.positions ?? 5000),
  seed: Number(args.seed ?? 42),
});

const headers = Object.values(config.columns);
const dateCol = config.columns.business_date;
const csvFiles = [];
for (const date of dates) {
  const path = resolve(outDir, `breaks_${date.replace(/-/g, '')}.csv`);
  writeFileSync(path, toCsv(rows.filter((r) => r[dateCol] === date), headers));
  csvFiles.push(path);
}
console.log(`${rows.length} synthetic rows over ${dates.length} business dates (${dates[0]} to ${dates.at(-1)}).`);

let duck = null;
try {
  const { openDuckDb } = await import('../src/db/duckdb.js');
  duck = await openDuckDb(':memory:');
} catch {
  console.log(`DuckDB not installed: only the CSV files were written to ${outDir}. Run \`npm install\` and repeat to generate Parquet.`);
  process.exit(0);
}

const recCol = config.columns.rec_stat_id;
try {
  for (const csv of csvFiles) {
    const parquet = csv.replace(/\.csv$/, '.parquet');
    await duck.exec(`
      COPY (
        SELECT * REPLACE (CAST("${recCol}" AS BIGINT) AS "${recCol}", CAST("${dateCol}" AS DATE) AS "${dateCol}")
        FROM read_csv('${csv}', header = true, all_varchar = true)
      ) TO '${parquet}' (FORMAT parquet)`);
    if (!args['keep-csv']) rmSync(csv);
  }
  console.log(`Parquet written to ${outDir}. Next step:\n  ODIN_BREAKS_GLOB=${outDir}/*.parquet npm run build:db`);
} finally {
  await duck.close();
}
