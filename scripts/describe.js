#!/usr/bin/env node
// Structure of a set of Parquet files, without showing data (names, types and counts only).
// Designed for wide files such as the DTCC report (hundreds of TP1_/TP2_ columns).
//
//   npm run describe -- "data/dtcc/**/*.parquet"
//   npm run describe -- "data/dtcc/**/*.parquet" --all                  # also lists the TP1_/TP2_ columns
//   npm run describe -- "data/dtcc/**/*.parquet" --key UTI,PROPRIETARY  # uniqueness of a candidate key
//   npm run describe -- "<glob>" --distinct COL1,COL2                    # number of distinct and null values per column
//   npm run describe -- "<glob>" --overlap COL_A,COL_B                   # number of values that appear in both columns
//   npm run describe -- "<glob>" --values TP1_CONFIRMED,TP2_CONFIRMED     # count per value of code columns
//       (refuses columns with more than 50 distinct values: they may be identifiers)
//
// The output can be pasted into chats: it contains no values, only structure and aggregates.
import fs from 'node:fs';
import { parseArgs } from '../src/cli.js';
import { openDuckDb } from '../src/db/duckdb.js';

const args = parseArgs(process.argv.slice(2));
const glob = args._[0];
if (!glob) {
  console.error('Usage: npm run describe -- "<parquet glob>" [--all] [--key COL1,COL2]');
  process.exit(1);
}
const files = fs.globSync ? fs.globSync(glob) : [];
console.log(`Files: ${files.length}`);
if (files.length === 0) process.exit(1);

const ident = (c) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c)) throw new Error(`Invalid column name: ${c}`);
  return `"${c}"`;
};
const src = `read_parquet('${glob.replace(/'/g, "''")}', union_by_name = true)`;
const db = await openDuckDb(':memory:');
try {
  const cols = await db.all(`DESCRIBE SELECT * FROM ${src}`);
  const names = cols.map((c) => c.column_name);
  const tp1 = cols.filter((c) => /^TP1_/i.test(c.column_name));
  const tp2 = cols.filter((c) => /^TP2_/i.test(c.column_name));
  const other = cols.filter((c) => !/^TP[12]_/i.test(c.column_name));

  const [{ n }] = await db.all(`SELECT COUNT(*) AS n FROM ${src}`);
  console.log(`Rows: ${n}`);
  console.log(`Columns: ${cols.length} (TP1_: ${tp1.length}, TP2_: ${tp2.length}, other: ${other.length})`);

  console.log('\n== Columns that are not TP1_/TP2_ ==');
  console.table(other.map((c) => ({ coluna: c.column_name, tipo: c.column_type })));

  // Asymmetric pairs: TP1_x without a matching TP2_x (and vice versa).
  const suffix = (c) => c.column_name.slice(4).toUpperCase();
  const s1 = new Set(tp1.map(suffix));
  const s2 = new Set(tp2.map(suffix));
  const only1 = [...s1].filter((x) => !s2.has(x)).sort();
  const only2 = [...s2].filter((x) => !s1.has(x)).sort();
  console.log(`\nTP1_/TP2_ pairs with the same suffix: ${[...s1].filter((x) => s2.has(x)).length}`);
  console.log(`TP1_ only (${only1.length}): ${only1.join(', ') || '-'}`);
  console.log(`TP2_ only (${only2.length}): ${only2.join(', ') || '-'}`);
  if (args.all) {
    console.log('\n== TP1_/TP2_ columns ==');
    console.table([...tp1, ...tp2].map((c) => ({ coluna: c.column_name, tipo: c.column_type })));
  }

  // REFERENCE_DATE: DTCC report date, to compare with BUSINESS_DATE and with the folder.
  for (const c of ['BUSINESS_DATE', 'REFERENCE_DATE', 'C_PRIMARY_ASSET_CLASS']) {
    if (!names.includes(c)) continue;
    console.log(`\n== Rows per ${c} ==`);
    console.table(await db.all(`SELECT ${ident(c)} AS value, COUNT(*) AS rows FROM ${src} GROUP BY 1 ORDER BY 1`));
  }

  if (args.key) {
    const key = String(args.key).split(',').map((k) => k.trim());
    for (const k of key) if (!names.includes(k)) throw new Error(`Key column does not exist: ${k}`);
    const keyExpr = key.map((k) => `COALESCE(CAST(${ident(k)} AS VARCHAR), '')`).join(` || '|' || `);
    const nulls = key.map((k) => `SUM(CASE WHEN ${ident(k)} IS NULL THEN 1 ELSE 0 END) AS null_${k}`).join(', ');
    const [r] = await db.all(`SELECT COUNT(*) AS rows, COUNT(DISTINCT ${keyExpr}) AS distinct_keys, ${nulls} FROM ${src}`);
    console.log(`\n== Candidate key: ${key.join(' + ')} ==`);
    console.table([r]);
  }
  if (args.distinct) {
    const cs = String(args.distinct).split(',').map((k) => k.trim());
    const rows = [];
    for (const c of cs) {
      if (!names.includes(c)) throw new Error(`Column does not exist: ${c}`);
      const [r] = await db.all(
        `SELECT COUNT(DISTINCT ${ident(c)}) AS distinct_values, SUM(CASE WHEN ${ident(c)} IS NULL THEN 1 ELSE 0 END) AS nulls FROM ${src}`,
      );
      rows.push({ column: c, ...r });
    }
    console.log('\n== Distinct values per column ==');
    console.table(rows);
  }

  if (args.values) {
    const MAX = 50;
    for (const c of String(args.values).split(',').map((k) => k.trim())) {
      if (!names.includes(c)) throw new Error(`Column does not exist: ${c}`);
      const [{ n }] = await db.all(`SELECT COUNT(DISTINCT ${ident(c)}) AS n FROM ${src}`);
      if (Number(n) > MAX) {
        console.log(`\n== ${c}: ${n} distinct values (> ${MAX}) — not shown (may contain identifiers) ==`);
        continue;
      }
      console.log(`\n== Values of ${c} ==`);
      console.table(await db.all(`SELECT ${ident(c)} AS value, COUNT(*) AS rows FROM ${src} GROUP BY 1 ORDER BY 2 DESC`));
    }
  }

  if (args.overlap) {
    const [a, b] = String(args.overlap).split(',').map((k) => k.trim());
    for (const c of [a, b]) if (!c || !names.includes(c)) throw new Error(`--overlap requires two existing columns: ${args.overlap}`);
    const [r] = await db.all(`SELECT
  (SELECT COUNT(DISTINCT ${ident(a)}) FROM ${src}) AS distinct_a,
  (SELECT COUNT(DISTINCT ${ident(b)}) FROM ${src}) AS distinct_b,
  (SELECT COUNT(*) FROM (SELECT DISTINCT ${ident(a)} AS v FROM ${src} WHERE ${ident(a)} IS NOT NULL
     INTERSECT SELECT DISTINCT ${ident(b)} FROM ${src} WHERE ${ident(b)} IS NOT NULL) i) AS in_both`);
    console.log(`\n== Value overlap: ${a} vs ${b} ==`);
    console.table([r]);
  }
} catch (err) {
  console.error(`${err.name}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
