#!/usr/bin/env node
// Motor de regras EMIR: avalia as validation rules ESMA nos dois lados de cada break e grava o veredicto.
//
//   npm run rules -- --date 2026-10-15            # rule_results + break_verdict dessa business date
//   npm run rules -- --date 2026-10-15 --stats    # taxa de violação por regra em TODAS as transações do ficheiro DTCC
//                                                 # (filtro de tradução: > 5% = regra suspeita); CSV em data/reports/
//
// Pré-requisitos: build:db feito (tabela breaks) e o ficheiro DTCC dessa data em ODIN_DTCC_GLOB.
// Só mostra contagens por regra / campo / veredicto (nunca valores nem identificadores).
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
  ruleInputSql, usedColumns, RESULTS_DDL, VERDICT_DDL, insertViolationsSql, insertVerdictSql, fieldRulesSql, DIVERGENCE_MESSAGE,
} from '../src/rules/sql.js';
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
const SUSPECT_PCT = 5;
const BATCH = 40;

const db = await openDuckDb(config.source.dbPath);
const t0 = Date.now();
try {
  const src = db.dialect.parquetSource(glob);
  const described = await db.all(`DESCRIBE SELECT * FROM ${src}`);
  const columns = new Map(described.map((c) => [String(c.column_name).toUpperCase(), String(c.column_type)]));
  const compiled = compileAll(rulesDoc, { fieldMap, columns, dialect: db.dialect });

  const field = (item) => fieldMap.items[item]?.field ?? item;
  const runtimeNv = compiled.flatMap((c) =>
    Object.entries(c.sides)
      .filter(([, s]) => s.notVerifiable && c.rule.status !== 'nao_verificavel')
      .map(([side, s]) => ({ code: c.rule.code, item: c.rule.item, lado: side, motivo: s.notVerifiable })),
  );

  const used = usedColumns(compiled);
  if (args.stats) {
    // Taxa de violação em todas as transações da data (não só nas que têm break).
    // Vista (não tabela): 6M+ linhas; o DuckDB lê do Parquet só as colunas de cada lote.
    await db.exec(`CREATE OR REPLACE TEMP VIEW rule_input AS\n${ruleInputSql(config, db.dialect, src, args.date, { onlyBreaks: false, columns: used })}`);
    const [{ n: total }] = await db.all('SELECT COUNT(*) AS n FROM rule_input');
    const exprs = compiled.flatMap((c, i) =>
      Object.entries(c.sides).filter(([, s]) => s.sql).map(([side, s]) => ({ i, side, sql: s.sql })),
    );
    const counts = new Map();
    for (let b = 0; b < exprs.length; b += BATCH) {
      const batch = exprs.slice(b, b + BATCH);
      const sel = batch.map((e, k) => `SUM(CASE WHEN ${e.sql} THEN 1 ELSE 0 END) AS v${k}`).join(',\n  ');
      const [row] = await db.all(`SELECT\n  ${sel}\nFROM rule_input`);
      batch.forEach((e, k) => counts.set(`${e.i}|${e.side}`, Number(row[`v${k}`] ?? 0)));
    }
    const pct = (n) => (Number(total) > 0 ? Math.round((n / Number(total)) * 10000) / 100 : null);
    const rows = compiled.map((c, i) => {
      const bn = counts.get(`${i}|BNPP`);
      const cp = counts.get(`${i}|CPTY`);
      const sus = [bn, cp].some((n) => n != null && pct(n) > SUSPECT_PCT);
      return {
        code: c.rule.code, item: c.rule.item, campo: field(c.rule.item), status: c.rule.status,
        bnpp: bn ?? '-', cpty: cp ?? '-', pct_bnpp: bn == null ? '-' : pct(bn), pct_cpty: cp == null ? '-' : pct(cp),
        suspeita: sus ? 'SIM' : '',
      };
    });
    const outDir = resolve(ROOT, 'data/reports');
    fs.mkdirSync(outDir, { recursive: true });
    const csv = resolve(outDir, `rules-stats-${args.date}.csv`);
    fs.writeFileSync(csv, toCsv(rows, Object.keys(rows[0])));

    console.log(`Regras ${version}: ${compiled.length} códigos; ${total} transações DTCC em ${args.date}.`);
    console.log(`\n== Regras suspeitas (> ${SUSPECT_PCT}% das transações violam): rever a tradução ==`);
    const suspects = rows.filter((r) => r.suspeita);
    console.table(suspects.length ? suspects : [{ resultado: 'nenhuma' }]);
    console.log('\n== Todas as regras avaliadas (ordenadas por violações) ==');
    console.table(
      rows.filter((r) => r.bnpp !== '-' || r.cpty !== '-')
        .sort((a, b) => (Number(b.bnpp) || 0) + (Number(b.cpty) || 0) - (Number(a.bnpp) || 0) - (Number(a.cpty) || 0)),
    );
    if (runtimeNv.length) {
      console.log('\n== Regras não avaliadas por causa das colunas do ficheiro DTCC ==');
      console.table(runtimeNv);
    }
    console.log(`\nResultado completo (só contagens): ${csv}`);
  } else {
    await db.exec(`CREATE OR REPLACE TEMP TABLE rule_input AS\n${ruleInputSql(config, db.dialect, src, args.date, { columns: used })}`);
    const [{ n: inputRows }] = await db.all('SELECT COUNT(*) AS n FROM rule_input');
    if (Number(inputRows) === 0) throw new Error(`Nenhuma transação DTCC de ${args.date} com break no data mart (build:db feito? ficheiro DTCC certo?)`);

    await db.exec(RESULTS_DDL);
    await db.exec(VERDICT_DDL);
    await db.exec(`DELETE FROM rule_results WHERE business_date = '${args.date}'`);
    await db.exec(`DELETE FROM break_verdict WHERE business_date = '${args.date}'`);
    for (const c of compiled) {
      for (const [side, s] of Object.entries(c.sides)) {
        if (s.sql) await db.exec(insertViolationsSql(args.date, c, side, s.sql, version));
      }
    }
    await db.exec('DROP TABLE IF EXISTS field_rules');
    await db.exec(fieldRulesSql(compiled));
    await db.exec(insertVerdictSql(args.date, db.dialect, version));

    const byVerdict = await db.all(`SELECT verdict, COUNT(*) AS breaks FROM break_verdict
WHERE business_date = '${args.date}' GROUP BY verdict ORDER BY breaks DESC`);
    const byField = await db.all(`SELECT breaking_field,
  COUNT(*) AS breaks,
  SUM(CASE WHEN verdict = 'so_bnpp' THEN 1 ELSE 0 END) AS so_bnpp,
  SUM(CASE WHEN verdict = 'so_contraparte' THEN 1 ELSE 0 END) AS so_contraparte,
  SUM(CASE WHEN verdict = 'ambos' THEN 1 ELSE 0 END) AS ambos,
  SUM(CASE WHEN verdict = 'divergencia' THEN 1 ELSE 0 END) AS divergencia,
  SUM(CASE WHEN verdict = 'sem_regras_verificaveis' THEN 1 ELSE 0 END) AS sem_regras
FROM break_verdict WHERE business_date = '${args.date}'
GROUP BY breaking_field ORDER BY breaks DESC LIMIT 20`);
    console.log(`Regras ${version} em ${args.date}: ${inputRows} transações DTCC com break avaliadas.`);
    console.log('\n== Veredicto por break ==');
    console.table(byVerdict);
    console.log('\n== Por campo (top 20) ==');
    console.table(byField);
    console.log(`\n"divergencia" = ${DIVERGENCE_MESSAGE}`);
    if (runtimeNv.length) console.log(`(${runtimeNv.length} regra/lado não avaliadas por causa das colunas DTCC: ver --stats)`);
  }
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)} s`);
} catch (err) {
  console.error(`${err.name}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
