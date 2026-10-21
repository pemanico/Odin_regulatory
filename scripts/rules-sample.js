#!/usr/bin/env node
// Sample of breaks for manual validation of the rules engine (by operations / Ordep).
//
//   npm run rules:sample -- --date 2026-10-15 [--n 10] [--field VALUATION_CCY]
//
// Picks N breaks from break_detail, spread across the verdicts (deterministic sample: the same N and the same
// date always give the same breaks), and writes data/reports/sample-<date>.csv with: production key, field
// (name in the rules document), BNPP value (TP1_<field>), other cpty value (TP2_<field>), verdict and the
// format/condition error on each side, plus two empty columns for the validation (correct Y/N, comment).
// The CSV contains identifiers and values: it stays on the PC. Only number, field and verdict are printed.
// Prerequisite: npm run rules -- --date <date>.
import fs from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';
import { parseArgs } from '../src/cli.js';
import { openDuckDb } from '../src/db/duckdb.js';
import { isValidDate, intValue, stringLiteral } from '../src/semantic/literals.js';
import { VERDICTS, VERDICT_TEXT } from '../src/rules/sql.js';
import { POSITION_KEY } from '../src/db/model.js';
import { toCsv } from '../src/synthetic/generate.js';

const args = parseArgs(process.argv.slice(2));
if (!isValidDate(args.date)) {
  console.error('Usage: npm run rules:sample -- --date YYYY-MM-DD [--n 10] [--field FIELD]');
  process.exit(1);
}
const D = args.date;
const N = intValue(args.n ?? 10, { min: 1, max: 200 });
const config = loadConfig();

const db = await openDuckDb(config.source.dbPath);
try {
  const fieldFilter = args.field ? ` AND breaking_field = ${stringLiteral(String(args.field).toUpperCase())}` : '';
  const present = new Map((await db.all(`SELECT verdict_text, COUNT(*) AS n FROM break_detail
WHERE business_date = '${D}'${fieldFilter} GROUP BY verdict_text`)).map((r) => [r.verdict_text, Number(r.n)]));
  if (present.size === 0) throw new Error(`No detail on ${D}: run npm run rules -- --date ${D} first`);

  // Quotas per verdict: equal split in VERDICTS order; the remainder goes to the first ones.
  const order = VERDICTS.map((v) => VERDICT_TEXT[v]).filter((t) => present.has(t));
  const base = Math.floor(N / order.length);
  const quota = Object.fromEntries(order.map((t) => [t, base]));
  for (let i = 0; i < N - order.length * base; i++) quota[order[i % order.length]] += 1;

  const keyConcat = POSITION_KEY.map((k) => `COALESCE(${k}, '')`).join(` || '|' || `);
  const picks = [];
  for (const t of order) {
    if (!quota[t]) continue;
    picks.push(...(await db.all(`SELECT * FROM break_detail
WHERE business_date = '${D}' AND verdict_text = ${stringLiteral(t)}${fieldFilter}
ORDER BY md5(${keyConcat} || '|' || breaking_field)
LIMIT ${quota[t]}`)));
  }

  const rows = picks.map((p, i) => ({
    n: i + 1,
    business_date: D,
    ...Object.fromEntries(POSITION_KEY.map((k) => [k, p[k]])),
    field: p.field_label,
    bnpp_value: p.bnpp_value ?? '',
    other_cpty_value: p.other_cpty_value ?? '',
    verdict: p.verdict_text,
    bnpp_error: p.bnpp_error ?? '',
    other_cpty_error: p.other_cpty_error ?? '',
    validation_correct_Y_N: '',
    comment: '',
  }));

  const outDir = resolve(ROOT, 'data/reports');
  fs.mkdirSync(outDir, { recursive: true });
  const out = resolve(outDir, `sample-${D}.csv`);
  fs.writeFileSync(out, toCsv(rows, Object.keys(rows[0])));
  console.log(`Sample of ${rows.length} breaks on ${D}:`);
  console.table(rows.map(({ n, field, verdict }) => ({ n, field, verdict })));
  console.log(`\nFile to validate (key and values — local only, do not paste): ${out}`);
  console.log('Check each row against the DTCC file and the rules document; report back only "n + correct Y/N + reason".');
} catch (err) {
  console.error(`${err.name}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
