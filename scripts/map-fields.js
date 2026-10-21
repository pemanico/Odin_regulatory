#!/usr/bin/env node
// Maps each BREAKING_FIELD to the TP1_/TP2_ pair of the DTCC file and validates the mapping with the data.
// Only prints field/column names and counts: safe to paste.
//
//   npm run map-fields -- --date 2026-10-15 [--top 20] [--dtcc "data/dtcc/**/*.parquet"]
//   npm run map-fields -- --date 2026-10-15 --map SPREAD_LEG2_TYP=SPRD_LEG2_TYP --map ...   # manual mapping
//   npm run map-fields -- --date 2026-10-15 --all-pairs   # validates the ~179 TP1_/TP2_ pairs (in batches);
//       # writes the full result to data/reports/map-fields-<date>.csv (counts only) and prints the ones that are not ok
//   npm run map-fields -- --date 2026-10-15 --explain VALUATION_AMT [--by VALUATION_RECONCILIATION,PAIRING]
//       # TP1 ≠ TP2 without a break: distribution by the report status columns (codes and counts only)
//
// Reading each mapped field (right suffix and raw comparison equal to Spark's):
//   pct_found ≈ 100        the data mart breaks exist in the DTCC file with the same key
//   pct_break_diff ≈ 100   in the breaks, TP1 ≠ TP2
//   pct_nobreak_diff ≈ 0   in the transactions without a break in this field, TP1 = TP2
// low pct_break_diff → wrong suffix. high pct_nobreak_diff → Spark normalises (formats, decimal places)
// before comparing: the rules must see the values as Spark sees them.
import fs from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { parseArgs } from '../src/cli.js';
import { openDuckDb } from '../src/db/duckdb.js';
import { isValidDate } from '../src/semantic/literals.js';
import { tpPairs, matchFields, dtccSelectSql, confusionSql, confusionRow, explainSql, classify } from '../src/analysis/fieldmap.js';
import { ROOT } from '../src/config.js';
import { toCsv } from '../src/synthetic/generate.js';

const DEFAULT_BY = ['VALUATION_RECONCILIATION', 'PAIRING', 'RECONCILIATION', 'REC_CATEGORY', 'REPORTING_TYPE'];

const args = parseArgs(process.argv.slice(2));
if (!isValidDate(args.date)) {
  console.error('Usage: npm run map-fields -- --date YYYY-MM-DD [--top 20] [--dtcc "<glob>"] [--map FIELD=SUFFIX ...]');
  process.exit(1);
}
const config = loadConfig(args.dtcc ? { source: { dtccGlob: args.dtcc } } : {});
const glob = config.source.dtccGlob;
const files = fs.globSync ? fs.globSync(glob) : [];
if (fs.globSync && files.length === 0) {
  console.error(`No DTCC Parquet files in: ${glob} (ODIN_DTCC_GLOB in .env or --dtcc)`);
  process.exit(1);
}
const top = Number(args.top ?? 20);
const overrides = Object.fromEntries(
  [].concat(args.map ?? []).map((m) => {
    const eq = String(m).indexOf('=');
    if (eq < 1) throw new Error(`Invalid --map (expected FIELD=SUFFIX): ${m}`);
    return [m.slice(0, eq).trim(), m.slice(eq + 1).trim()];
  }),
);

const BATCH = 20;

/** Validates every TP1_/TP2_ pair: one batch of pairs at a time, so as not to materialise the 358 columns. */
async function validateAllPairs(db, src, pairs) {
  const fieldCounts = await db.all(`SELECT UPPER(breaking_field) AS breaking_field, COUNT(*) AS n
FROM breaks WHERE business_date = '${args.date}' GROUP BY UPPER(breaking_field)`);
  if (fieldCounts.length === 0) throw new Error(`No breaks on ${args.date} in the database ${config.source.dbPath}`);
  const matches = matchFields(fieldCounts.map((f) => f.breaking_field), pairs, overrides);
  const fieldOfPair = new Map(matches.filter((m) => m.pair).map((m) => [m.pair.tp1, m]));

  const rows = [];
  for (let start = 0; start < pairs.length; start += BATCH) {
    const batch = pairs.slice(start, start + BATCH);
    await db.exec(`CREATE OR REPLACE TEMP TABLE dtcc AS\n${dtccSelectSql(config, db.dialect, src, args.date, batch)}`);
    for (const [i, p] of batch.entries()) {
      const m = fieldOfPair.get(p.tp1);
      const field = m ? m.field : p.suffix.toUpperCase();
      const r = confusionRow((await db.all(confusionSql(args.date, field, i)))[0]);
      rows.push({ suffix: p.suffix, breaking_field: m ? m.field : '-', how: m ? m.how : '-', status: classify(r), ...r });
    }
    process.stdout.write(`\r${Math.min(start + BATCH, pairs.length)}/${pairs.length} pairs`);
  }
  await db.exec('DROP TABLE IF EXISTS dtcc');
  console.log('');

  const outDir = resolve(ROOT, 'data/reports');
  fs.mkdirSync(outDir, { recursive: true });
  const csv = resolve(outDir, `map-fields-${args.date}.csv`);
  fs.writeFileSync(csv, toCsv(rows, Object.keys(rows[0])));

  const summary = {};
  for (const r of rows) summary[r.estado] = (summary[r.estado] ?? 0) + 1;
  console.log(`\n== Summary of the ${pairs.length} TP1_/TP2_ pairs (${args.date}) ==`);
  console.table(Object.entries(summary).map(([estado, pares]) => ({ estado, pares })));

  const notOk = rows.filter((r) => !['ok', 'no differences'].includes(r.status));
  if (notOk.length) {
    console.log('\n== Pairs that are not ok ==');
    console.table(notOk.map(({ sufixo, breaking_field, estado, n_breaks, break_equal, nobreak_diff, pct_found, pct_nobreak_diff }) =>
      ({ sufixo, breaking_field, estado, n_breaks, break_equal, nobreak_diff, pct_found, pct_nobreak_diff })));
  }
  const orphan = matches.filter((m) => !m.pair);
  if (orphan.length) {
    console.log('\n== BREAKING_FIELD without a TP pair of the same name (use --map FIELD=SUFFIX) ==');
    const n = new Map(fieldCounts.map((f) => [f.breaking_field, Number(f.n)]));
    console.table(orphan.map((m) => ({ breaking_field: m.field, n_breaks: n.get(m.field), candidates: m.candidates.join(', ') || '-' })));
  }
  console.log(`\nFull result (counts only): ${csv}`);
}

const db = await openDuckDb(config.source.dbPath);
const t0 = Date.now();
async function main() {
  const src = db.dialect.parquetSource(glob);
  const names = (await db.all(`DESCRIBE SELECT * FROM ${src}`)).map((c) => c.column_name);
  const pairs = tpPairs(names);

  if (args['all-pairs']) {
    await validateAllPairs(db, src, pairs);
    return;
  }

  const fields = await db.all(`SELECT UPPER(breaking_field) AS breaking_field, COUNT(*) AS n
FROM breaks WHERE business_date = '${args.date}'
GROUP BY UPPER(breaking_field) ORDER BY n DESC, 1 LIMIT ${top}`);
  if (fields.length === 0) throw new Error(`No breaks on ${args.date} in the database ${config.source.dbPath}`);

  const explain = args.explain ? String(args.explain).toUpperCase() : null;
  const fieldNames = fields.map((f) => f.breaking_field);
  if (explain && !fieldNames.includes(explain)) fieldNames.push(explain);
  const matches = matchFields(fieldNames, pairs, overrides);
  const mapped = matches.filter((m) => m.pair);
  const by = explain ? (args.by ? String(args.by).split(',').map((c) => c.trim()) : DEFAULT_BY).filter((c) => names.includes(c)) : [];

  // Temp table with only the key and the needed pairs (not the 380 columns).
  await db.exec(`CREATE OR REPLACE TEMP TABLE dtcc AS\n${dtccSelectSql(config, db.dialect, src, args.date, mapped.map((m) => m.pair), by)}`);
  const [{ n: dtccRows }] = await db.all('SELECT COUNT(*) AS n FROM dtcc');
  console.log(`DTCC file ${args.date}: ${dtccRows} transactions, ${pairs.length} TP pairs. Fields analysed: ${fields.length}.`);
  if (Number(dtccRows) === 0) throw new Error(`The DTCC file has no rows with BUSINESS_DATE = ${args.date}`);

  const out = [];
  for (const [idx, m] of mapped.entries()) {
    const [r] = await db.all(confusionSql(args.date, m.field, idx));
    out.push({ breaking_field: m.field, suffix: m.pair.suffix, how: m.how, ...confusionRow(r) });
  }
  console.log('\n== Mapped fields: data mart breaks vs. TP1 ≠ TP2 in the DTCC file ==');
  console.table(out);

  if (explain) {
    const idx = mapped.findIndex((m) => m.field === explain);
    if (idx < 0) throw new Error(`--explain ${explain}: field without a TP pair (use --map)`);
    if (by.length === 0) throw new Error('--by: none of the columns exists in the DTCC file');
    const rows = await db.all(explainSql(args.date, explain, idx, by.length));
    console.log(`\n== ${explain}: break / no break × TP1 ≠ TP2, by ${by.join(' × ')} ==`);
    console.table(
      rows.map((r) => ({
        ...Object.fromEntries(by.map((c, k) => [c, r[`st_${k}`]])),
        break_diff: Number(r.break_diff), break_equal: Number(r.break_equal),
        nobreak_diff: Number(r.nobreak_diff), nobreak_equal: Number(r.nobreak_equal),
      })),
    );
  }

  const unmatched = matches.filter((m) => !m.pair);
  if (unmatched.length) {
    console.log('\n== Fields without a TP pair of the same name (confirm and repeat with --map FIELD=SUFFIX) ==');
    console.table(unmatched.map((m) => ({ breaking_field: m.field, candidates: m.candidates.join(', ') || '-' })));
  }
}

try {
  await main();
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)} s`);
} catch (err) {
  console.error(`${err.name}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
