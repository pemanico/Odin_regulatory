#!/usr/bin/env node
// Motor de regras EMIR: avalia as validation rules ESMA nos dois lados de cada break do data mart
// e grava o veredicto. Âmbito: só os breaks do data mart (validar o ficheiro DTCC inteiro = "data quality", futuro).
//
//   npm run rules -- --date 2026-10-15            # rule_results + break_verdict; resumo + regras suspeitas
//   npm run rules -- --date 2026-10-15 --stats    # mostra também a tabela completa por regra
//
// Taxa por regra = violações / breaks do campo da regra. Regra suspeita (tradução a rever): viola nos DOIS
// lados em mais de 5% dos breaks do seu campo. CSV completo em data/reports/rules-<data>.csv (só contagens).
// Detalhe por break COM a chave (para os operacionais encontrarem o break): data/reports/break-verdict-<data>.csv.
// Esse ficheiro tem identificadores (UTI, LEIs): fica só no PC, nunca colar em chats nem commitar.
// Pré-requisitos: build:db feito (tabela breaks) e o ficheiro DTCC dessa data em ODIN_DTCC_GLOB.
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
} from '../src/rules/sql.js';
import { describeRule, fieldLabel } from '../src/rules/describe.js';
import { toCsv } from '../src/synthetic/generate.js';

const args = parseArgs(process.argv.slice(2));
if (!isValidDate(args.date)) {
  console.error('Uso: npm run rules -- --date YYYY-MM-DD [--stats]');
  process.exit(1);
}
const config = loadConfig();
assertNotExcluded(args.date, config.excludedDates);
const { fieldMap, rulesDoc } = loadRules();
const version = rulesDoc.version;
const glob = config.source.dtccGlob;
if (fs.globSync && fs.globSync(glob).length === 0) {
  console.error(`Nenhum Parquet DTCC em: ${glob} (ODIN_DTCC_GLOB no .env)`);
  process.exit(1);
}
const D = args.date;

const db = await openDuckDb(config.source.dbPath);
const t0 = Date.now();
try {
  const src = db.dialect.parquetSource(glob);
  const described = await db.all(`DESCRIBE SELECT * FROM ${src}`);
  const columns = new Map(described.map((c) => [String(c.column_name).toUpperCase(), String(c.column_type)]));
  const compiled = compileAll(rulesDoc, { fieldMap, columns, dialect: db.dialect });

  // Entrada: transações DTCC com break, com as colunas que as regras usam + as TP1_/TP2_ dos campos em break
  // (para mostrar os valores dos dois lados no detalhe).
  const breakFields = (await db.all(breaksByFieldSql(D))).map((r) => String(r.target));
  const valueFields = breakFields.filter((f) => columns.has(`TP1_${f}`) && columns.has(`TP2_${f}`)).sort();
  const inputCols = [...new Set([...usedColumns(compiled), ...valueFields.flatMap((f) => [`TP1_${f}`, `TP2_${f}`])])]
    .map((c) => described.find((d) => String(d.column_name).toUpperCase() === c)?.column_name ?? c);
  await db.exec(`CREATE OR REPLACE TEMP TABLE rule_input AS\n${ruleInputSql(config, db.dialect, src, D, { columns: inputCols })}`);
  const [{ n: inputRows }] = await db.all('SELECT COUNT(*) AS n FROM rule_input');
  if (Number(inputRows) === 0) throw new Error(`Nenhuma transação DTCC de ${D} com break no data mart (build:db feito? ficheiro DTCC certo?)`);

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

  // Taxa por regra (sobre os breaks do campo da regra).
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
      code: c.rule.code, item: c.rule.item, campo: target || '-', status: c.rule.status, breaks_campo: nb,
      bnpp: bn ?? '-', cpty: cp ?? '-', pct_bnpp: pb ?? '-', pct_cpty: pc ?? '-',
      suspeita: isSuspect(pb, pc) ? 'SIM' : '', nao_avaliada: nv,
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
  SUM(CASE WHEN verdict = 'so_bnpp' THEN 1 ELSE 0 END) AS so_bnpp,
  SUM(CASE WHEN verdict = 'so_contraparte' THEN 1 ELSE 0 END) AS so_contraparte,
  SUM(CASE WHEN verdict = 'ambos' THEN 1 ELSE 0 END) AS ambos,
  SUM(CASE WHEN verdict = 'divergencia' THEN 1 ELSE 0 END) AS divergencia,
  SUM(CASE WHEN verdict = 'sem_regras_verificaveis' THEN 1 ELSE 0 END) AS sem_regras
FROM break_verdict WHERE business_date = '${D}'
GROUP BY breaking_field ORDER BY breaks DESC LIMIT 20`);

  console.log(`Regras ${version} em ${D}: ${compiled.length} códigos VR; ${inputRows} transações DTCC com break.`);
  console.log('\n== Veredicto por break ==');
  console.table(byVerdict);
  console.log('\n== Por campo (top 20) ==');
  console.table(byField);
  console.log(`"divergencia" = ${DIVERGENCE_MESSAGE}`);

  console.log('\n== Regras suspeitas (violam nos dois lados em > 5% dos breaks do campo): rever a tradução ==');
  const suspects = rows.filter((r) => r.suspeita);
  console.table(suspects.length ? suspects : [{ resultado: 'nenhuma' }]);
  const runtimeNv = rows.filter((r) => r.nao_avaliada && r.status !== 'nao_verificavel');
  if (runtimeNv.length) {
    console.log('\n== Regras não avaliadas por causa das colunas do ficheiro DTCC ==');
    console.table(runtimeNv.map(({ code, campo, nao_avaliada }) => ({ code, campo, nao_avaliada })));
  }
  if (args.stats) {
    console.log('\n== Todas as regras ==');
    console.table(rows);
  }
  // Detalhe por break (tabela break_detail + CSV local): chave, campo ESMA, valores TP1/TP2, veredicto e erros.
  for (const sql of catalogTablesSql(compiled, fieldMap, describeRule, fieldLabel)) await db.exec(sql);
  await db.exec(DETAIL_DDL);
  await db.exec(`DELETE FROM break_detail WHERE business_date = '${D}'`);
  await db.exec(insertDetailSql(D, db.dialect, valueFields, version));
  const detail = resolve(outDir, `break-verdict-${D}.csv`);
  await db.exec(`COPY (
  SELECT * EXCLUDE (rules_version) FROM break_detail WHERE business_date = '${D}'
  ORDER BY campo, veredicto, cp2_lei, uti, proprietary
) TO '${detail.replace(/'/g, "''")}' (HEADER, DELIMITER ',')`);

  console.log(`\nResultado completo por regra (só contagens): ${csv}`);
  console.log(`Detalhe por break com a chave (UTI/PROPRIETARY, LEIs) — só local, não colar: ${detail}`);
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s`);
} catch (err) {
  console.error(`${err.name}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
