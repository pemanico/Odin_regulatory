#!/usr/bin/env node
// Mapeia cada BREAKING_FIELD ao par TP1_/TP2_ do ficheiro DTCC e valida o mapeamento com os dados.
// Só mostra nomes de campos/colunas e contagens: pode ser colado.
//
//   npm run map-fields -- --date 2026-10-15 [--top 20] [--dtcc "data/dtcc/**/*.parquet"]
//   npm run map-fields -- --date 2026-10-15 --map SPREAD_LEG2_TYP=SPRD_LEG2_TYP --map ...   # mapeamento manual
//   npm run map-fields -- --date 2026-10-15 --all-pairs   # valida os ~179 pares TP1_/TP2_ (por lotes);
//       # escreve o resultado completo em data/reports/map-fields-<data>.csv (só contagens) e mostra os que não estão ok
//   npm run map-fields -- --date 2026-10-15 --explain VALUATION_AMT [--by VALUATION_RECONCILIATION,PAIRING]
//       # TP1 ≠ TP2 sem break: distribuição pelas colunas de estado do relatório (só códigos e contagens)
//
// Leitura de cada campo mapeado (sufixo certo e comparação bruta igual à do Spark):
//   pct_found ≈ 100        os breaks do data mart existem no ficheiro DTCC com a mesma chave
//   pct_break_diff ≈ 100   nos breaks, TP1 ≠ TP2
//   pct_nobreak_diff ≈ 0   nas transações sem break neste campo, TP1 = TP2
// pct_break_diff baixo → sufixo errado. pct_nobreak_diff alto → o Spark normaliza (formatos, casas decimais)
// antes de comparar: as regras têm de ver os valores como o Spark os vê.
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
  console.error('Uso: npm run map-fields -- --date YYYY-MM-DD [--top 20] [--dtcc "<glob>"] [--map CAMPO=SUFIXO ...]');
  process.exit(1);
}
const config = loadConfig(args.dtcc ? { source: { dtccGlob: args.dtcc } } : {});
const glob = config.source.dtccGlob;
const files = fs.globSync ? fs.globSync(glob) : [];
if (fs.globSync && files.length === 0) {
  console.error(`Nenhum Parquet DTCC em: ${glob} (ODIN_DTCC_GLOB no .env ou --dtcc)`);
  process.exit(1);
}
const top = Number(args.top ?? 20);
const overrides = Object.fromEntries(
  [].concat(args.map ?? []).map((m) => {
    const eq = String(m).indexOf('=');
    if (eq < 1) throw new Error(`--map inválido (esperado CAMPO=SUFIXO): ${m}`);
    return [m.slice(0, eq).trim(), m.slice(eq + 1).trim()];
  }),
);

const BATCH = 20;

/** Valida todos os pares TP1_/TP2_: um lote de pares de cada vez, para não materializar as 358 colunas. */
async function validateAllPairs(db, src, pairs) {
  const fieldCounts = await db.all(`SELECT UPPER(breaking_field) AS breaking_field, COUNT(*) AS n
FROM breaks WHERE business_date = '${args.date}' GROUP BY UPPER(breaking_field)`);
  if (fieldCounts.length === 0) throw new Error(`Sem breaks em ${args.date} na base ${config.source.dbPath}`);
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
      rows.push({ sufixo: p.suffix, breaking_field: m ? m.field : '-', como: m ? m.how : '-', estado: classify(r), ...r });
    }
    process.stdout.write(`\r${Math.min(start + BATCH, pairs.length)}/${pairs.length} pares`);
  }
  await db.exec('DROP TABLE IF EXISTS dtcc');
  console.log('');

  const outDir = resolve(ROOT, 'data/reports');
  fs.mkdirSync(outDir, { recursive: true });
  const csv = resolve(outDir, `map-fields-${args.date}.csv`);
  fs.writeFileSync(csv, toCsv(rows, Object.keys(rows[0])));

  const summary = {};
  for (const r of rows) summary[r.estado] = (summary[r.estado] ?? 0) + 1;
  console.log(`\n== Resumo dos ${pairs.length} pares TP1_/TP2_ (${args.date}) ==`);
  console.table(Object.entries(summary).map(([estado, pares]) => ({ estado, pares })));

  const notOk = rows.filter((r) => !['ok', 'sem diferenças'].includes(r.estado));
  if (notOk.length) {
    console.log('\n== Pares que não estão ok ==');
    console.table(notOk.map(({ sufixo, breaking_field, estado, n_breaks, break_equal, nobreak_diff, pct_found, pct_nobreak_diff }) =>
      ({ sufixo, breaking_field, estado, n_breaks, break_equal, nobreak_diff, pct_found, pct_nobreak_diff })));
  }
  const orphan = matches.filter((m) => !m.pair);
  if (orphan.length) {
    console.log('\n== BREAKING_FIELD sem par TP com o mesmo nome (usar --map CAMPO=SUFIXO) ==');
    const n = new Map(fieldCounts.map((f) => [f.breaking_field, Number(f.n)]));
    console.table(orphan.map((m) => ({ breaking_field: m.field, n_breaks: n.get(m.field), candidatos: m.candidates.join(', ') || '-' })));
  }
  console.log(`\nResultado completo (só contagens): ${csv}`);
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
  if (fields.length === 0) throw new Error(`Sem breaks em ${args.date} na base ${config.source.dbPath}`);

  const explain = args.explain ? String(args.explain).toUpperCase() : null;
  const fieldNames = fields.map((f) => f.breaking_field);
  if (explain && !fieldNames.includes(explain)) fieldNames.push(explain);
  const matches = matchFields(fieldNames, pairs, overrides);
  const mapped = matches.filter((m) => m.pair);
  const by = explain ? (args.by ? String(args.by).split(',').map((c) => c.trim()) : DEFAULT_BY).filter((c) => names.includes(c)) : [];

  // Tabela temporária só com a chave e os pares necessários (não as 380 colunas).
  await db.exec(`CREATE OR REPLACE TEMP TABLE dtcc AS\n${dtccSelectSql(config, db.dialect, src, args.date, mapped.map((m) => m.pair), by)}`);
  const [{ n: dtccRows }] = await db.all('SELECT COUNT(*) AS n FROM dtcc');
  console.log(`Ficheiro DTCC ${args.date}: ${dtccRows} transações, ${pairs.length} pares TP. Campos analisados: ${fields.length}.`);
  if (Number(dtccRows) === 0) throw new Error(`O ficheiro DTCC não tem linhas com BUSINESS_DATE = ${args.date}`);

  const out = [];
  for (const [idx, m] of mapped.entries()) {
    const [r] = await db.all(confusionSql(args.date, m.field, idx));
    out.push({ breaking_field: m.field, sufixo: m.pair.suffix, como: m.how, ...confusionRow(r) });
  }
  console.log('\n== Campos mapeados: breaks do data mart vs. TP1 ≠ TP2 no ficheiro DTCC ==');
  console.table(out);

  if (explain) {
    const idx = mapped.findIndex((m) => m.field === explain);
    if (idx < 0) throw new Error(`--explain ${explain}: campo sem par TP (usar --map)`);
    if (by.length === 0) throw new Error('--by: nenhuma das colunas existe no ficheiro DTCC');
    const rows = await db.all(explainSql(args.date, explain, idx, by.length));
    console.log(`\n== ${explain}: break / sem break × TP1 ≠ TP2, por ${by.join(' × ')} ==`);
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
    console.log('\n== Campos sem par TP com o mesmo nome (confirmar e repetir com --map CAMPO=SUFIXO) ==');
    console.table(unmatched.map((m) => ({ breaking_field: m.field, candidatos: m.candidates.join(', ') || '-' })));
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
