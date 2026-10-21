#!/usr/bin/env node
// EMIR rules engine: evaluates the ESMA validation rules on both sides of every data mart break
// and stores the verdict. Scope: data mart breaks only (validating the whole DTCC file = "data quality", future).
//
//   npm run rules -- --date 2026-10-15            # rule_results, break_verdict, break_detail, key_summary; summary + suspect rules
//   npm run rules -- --date 2026-10-15 --stats    # also prints the full table per rule
//
// Rate per rule = violations / breaks of the rule's field. Suspect rule (translation to review): violates on BOTH
// sides in more than 5% of the breaks of its field. Full CSV in data/reports/rules-<date>.csv (counts only).
// Detail per break WITH the key (so that operations can find the break): data/reports/break-verdict-<date>.csv.
// That file contains identifiers (UTI, LEIs): it stays on the PC, never paste it in chats or commit it.
// Prerequisites: build:db done (breaks table) and the DTCC file for that date in ODIN_DTCC_GLOB.
import fs from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';
import { parseArgs } from '../src/cli.js';
import { openDuckDb } from '../src/db/duckdb.js';
import { isValidDate } from '../src/semantic/literals.js';
import { assertNotExcluded } from '../src/semantic/calendar.js';
import { loadRules } from '../src/rules/catalog.js';
import { compileAll } from '../src/rules/compile.js';
import {
  ruleInputSql, usedColumns, RESULTS_DDL, VERDICT_DDL, insertViolationsSql, insertVerdictSql, fieldRulesSql,
  violationCountsSql, breaksByFieldSql, isSuspect, DIVERGENCE_MESSAGE, catalogTablesSql, DETAIL_DDL, insertDetailSql,
  KEY_SUMMARY_DDL, insertKeySummarySql, hasLegacyRuleTables, RULE_TABLES,
} from '../src/rules/sql.js';
import { describeRule, fieldLabel } from '../src/rules/describe.js';
import { toCsv } from '../src/synthetic/generate.js';

const args = parseArgs(process.argv.slice(2));
if (!isValidDate(args.date)) {
  console.error('Usage: npm run rules -- --date YYYY-MM-DD [--stats]');
  process.exit(1);
}
const config = loadConfig();
assertNotExcluded(args.date, config.excludedDates);
const { fieldMap, rulesDoc } = loadRules();
const version = rulesDoc.version;
const glob = config.source.dtccGlob;
if (fs.globSync && fs.globSync(glob).length === 0) {
  console.error(`No DTCC Parquet files in: ${glob} (ODIN_DTCC_GLOB in .env)`);
  process.exit(1);
}
const D = args.date;

const db = await openDuckDb(config.source.dbPath);
const t0 = Date.now();
try {
  // Tables from before the English migration (2026-10-21) are dropped: every date must be run again.
  if (await hasLegacyRuleTables(db)) {
    for (const t of RULE_TABLES) await db.exec(`DROP TABLE IF EXISTS ${t}`);
    console.log('Rule tables with the legacy (Portuguese) schema were dropped: run `npm run rules` again for every business date.\n');
  }

  const src = db.dialect.parquetSource(glob);
  const described = await db.all(`DESCRIBE SELECT * FROM ${src}`);
  const columns = new Map(described.map((c) => [String(c.column_name).toUpperCase(), String(c.column_type)]));
  const compiled = compileAll(rulesDoc, { fieldMap, columns, dialect: db.dialect });

  // Input: DTCC transactions with a break, with the columns used by the rules + the TP1_/TP2_ of the fields in break
  // (to show both sides' values in the detail).
  const breakFields = (await db.all(breaksByFieldSql(D))).map((r) => String(r.target));
  const valueFields = breakFields.filter((f) => columns.has(`TP1_${f}`) && columns.has(`TP2_${f}`)).sort();
  const inputCols = [...new Set([...usedColumns(compiled), ...valueFields.flatMap((f) => [`TP1_${f}`, `TP2_${f}`])])]
    .map((c) => described.find((d) => String(d.column_name).toUpperCase() === c)?.column_name ?? c);
  await db.exec(`CREATE OR REPLACE TEMP TABLE rule_input AS\n${ruleInputSql(config, db.dialect, src, D, { columns: inputCols })}`);
  const [{ n: inputRows }] = await db.all('SELECT COUNT(*) AS n FROM rule_input');
  if (Number(inputRows) === 0) {
    // Diagnosis: which side is empty for this date (counts and dates only, no data).
    const dateCol = db.dialect.castDate(`"${config.columns.business_date}"`, null);
    const [{ n: nBreaks }] = await db.all(`SELECT COUNT(*) AS n FROM breaks WHERE business_date = '${D}'`);
    const breakDates = (await db.all('SELECT business_date AS d, COUNT(*) AS n FROM breaks GROUP BY 1 ORDER BY 1'))
      .map((r) => `${String(r.d).slice(0, 10)} (${r.n})`);
    const dtccDates = (await db.all(`SELECT ${dateCol} AS d, COUNT(*) AS n FROM ${src} GROUP BY 1 ORDER BY 1`))
      .map((r) => `${String(r.d).slice(0, 10)} (${r.n})`);
    const lines = [
      `No DTCC transactions on ${D} with a break in the data mart.`,
      `  DuckDB database: ${config.source.dbPath}`,
      `  Breaks (data mart) per business date: ${breakDates.join(', ') || 'none'}`,
      `  DTCC file (${glob}) per business date: ${dtccDates.join(', ') || 'none'}`,
    ];
    if (Number(nBreaks) === 0) lines.push(`  -> The database has no breaks on ${D}: copy that date's Parquet files to data/breaks and run npm run build:db.`);
    else if (!dtccDates.some((x) => x.startsWith(D))) lines.push(`  -> The DTCC file for ${D} is missing: copy it from S3 to data/dtcc/{asset_class}/${D}/.`);
    else lines.push('  -> Both sources have the date but the keys do not match: compare the key columns (describe --key).');
    throw new Error(lines.join('\n'));
  }

  await db.exec(RESULTS_DDL);
  await db.exec(VERDICT_DDL);
  await db.exec(`DELETE FROM rule_results WHERE business_date = '${D}'`);
  await db.exec(`DELETE FROM break_verdict WHERE business_date = '${D}'`);
  for (const c of compiled) {
    if (!c.suffix) continue;
    for (const [side, s] of Object.entries(c.sides)) if (s.sql) await db.exec(insertViolationsSql(D, c, side, s.sql, version));
  }
  await db.exec('DROP TABLE IF EXISTS field_rules');
  await db.exec(fieldRulesSql(compiled));
  await db.exec(insertVerdictSql(D, db.dialect, version));

  // Rate per rule (over the breaks of the rule's field).
  const nBreaks = new Map((await db.all(breaksByFieldSql(D))).map((r) => [r.target, Number(r.n)]));
  const viol = new Map((await db.all(violationCountsSql(D))).map((r) => [`${r.code}|${r.side}`, Number(r.n)]));
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 10000) / 100 : null);
  const rows = compiled.map((c) => {
    const target = String(c.suffix ?? '').toUpperCase();
    const nb = nBreaks.get(target) ?? 0;
    const side = (s) => (c.sides[s].sql ? viol.get(`${c.rule.code}|${s}`) ?? 0 : null);
    const bn = side('BNPP');
    const cp = side('CPTY');
    const pb = bn == null ? null : pct(bn, nb);
    const pc = cp == null ? null : pct(cp, nb);
    const nv = Object.values(c.sides).find((s) => s.notVerifiable)?.notVerifiable ?? '';
    return {
      code: c.rule.code, item: c.rule.item, field: target || '-', status: c.rule.status, field_breaks: nb,
      bnpp: bn ?? '-', cpty: cp ?? '-', pct_bnpp: pb ?? '-', pct_cpty: pc ?? '-',
      suspect: isSuspect(pb, pc) ? 'YES' : '', not_evaluated: nv,
    };
  });
  const outDir = resolve(ROOT, 'data/reports');
  fs.mkdirSync(outDir, { recursive: true });
  const csv = resolve(outDir, `rules-${D}.csv`);
  fs.writeFileSync(csv, toCsv(rows, Object.keys(rows[0])));

  const byVerdict = await db.all(`SELECT verdict, COUNT(*) AS breaks FROM break_verdict
WHERE business_date = '${D}' GROUP BY verdict ORDER BY breaks DESC`);
  const byField = await db.all(`SELECT breaking_field,
  COUNT(*) AS breaks,
  SUM(CASE WHEN verdict = 'bnpp_only' THEN 1 ELSE 0 END) AS bnpp_only,
  SUM(CASE WHEN verdict = 'cpty_only' THEN 1 ELSE 0 END) AS cpty_only,
  SUM(CASE WHEN verdict = 'both' THEN 1 ELSE 0 END) AS both,
  SUM(CASE WHEN verdict = 'divergence' THEN 1 ELSE 0 END) AS divergence,
  SUM(CASE WHEN verdict = 'no_verifiable_rules' THEN 1 ELSE 0 END) AS no_rules
FROM break_verdict WHERE business_date = '${D}'
GROUP BY breaking_field ORDER BY breaks DESC LIMIT 20`);

  console.log(`Rules ${version} on ${D}: ${compiled.length} VR codes; ${inputRows} DTCC transactions with a break.`);
  console.log('\n== Verdict per break ==');
  console.table(byVerdict);
  console.log('\n== Per field (top 20) ==');
  console.table(byField);
  console.log(`"divergence" = ${DIVERGENCE_MESSAGE}`);

  console.log('\n== Suspect rules (violate on both sides in > 5% of the field breaks): review the translation ==');
  const suspects = rows.filter((r) => r.suspect);
  console.table(suspects.length ? suspects : [{ result: 'none' }]);
  const runtimeNv = rows.filter((r) => r.not_evaluated && r.status !== 'not_verifiable');
  if (runtimeNv.length) {
    console.log('\n== Rules not evaluated because of the DTCC file columns ==');
    console.table(runtimeNv.map(({ code, field, not_evaluated }) => ({ code, field, not_evaluated })));
  }
  if (args.stats) {
    console.log('\n== All rules ==');
    console.table(rows);
  }
  // Detail per break (break_detail table + local CSV): key, ESMA field, TP1/TP2 values, verdict and errors.
  for (const sql of catalogTablesSql(compiled, fieldMap, describeRule, fieldLabel)) await db.exec(sql);
  await db.exec(DETAIL_DDL);
  await db.exec(`DELETE FROM break_detail WHERE business_date = '${D}'`);
  await db.exec(insertDetailSql(D, db.dialect, valueFields, version));
  // Summary per Key (transaction) for the UI drill-down: number of fields, combination, Key verdict.
  await db.exec(KEY_SUMMARY_DDL);
  await db.exec(`DELETE FROM key_summary WHERE business_date = '${D}'`);
  await db.exec(insertKeySummarySql(D, db.dialect, version));
  const byKey = await db.all(`SELECT key_verdict, COUNT(*) AS keys FROM key_summary
WHERE business_date = '${D}' GROUP BY key_verdict ORDER BY keys DESC`);
  console.log('\n== Verdict per Key (transaction) ==');
  console.table(byKey);
  const detail = resolve(outDir, `break-verdict-${D}.csv`);
  await db.exec(`COPY (
  SELECT * EXCLUDE (rules_version) FROM break_detail WHERE business_date = '${D}'
  ORDER BY field_label, verdict_text, cp2_lei, uti, proprietary
) TO '${detail.replace(/'/g, "''")}' (HEADER, DELIMITER ',')`);

  console.log(`\nFull result per rule (counts only): ${csv}`);
  console.log(`Detail per break with the key (UTI/PROPRIETARY, LEIs) — local only, do not paste: ${detail}`);
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s`);
} catch (err) {
  console.error(`${err.name}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
