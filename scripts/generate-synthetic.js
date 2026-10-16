#!/usr/bin/env node
// Gera dados sintéticos de breaks (um ficheiro por business date) para desenvolver sem dados reais.
//
//   npm run synthetic -- [--days 4] [--positions 5000] [--start 2026-10-12] [--seed 42] [--out data/synthetic] [--keep-csv]
//
// Escreve CSV e, se o DuckDB estiver instalado, converte para Parquet.
// Depois: ODIN_BREAKS_GLOB=data/synthetic/*.parquet npm run build:db
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
console.log(`${rows.length} linhas sintéticas em ${dates.length} business dates (${dates[0]} a ${dates.at(-1)}).`);

let duck = null;
try {
  const { openDuckDb } = await import('../src/db/duckdb.js');
  duck = await openDuckDb(':memory:');
} catch {
  console.log(`DuckDB não instalado: ficaram só os CSV em ${outDir}. Corre \`npm install\` e repete para gerar Parquet.`);
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
  console.log(`Parquet escrito em ${outDir}. Próximo passo:\n  ODIN_BREAKS_GLOB=${outDir}/*.parquet npm run build:db`);
} finally {
  await duck.close();
}
