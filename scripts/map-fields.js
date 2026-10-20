#!/usr/bin/env node
// Mapeia cada BREAKING_FIELD ao par TP1_/TP2_ do ficheiro DTCC e valida o mapeamento com os dados.
// Só mostra nomes de campos/colunas e contagens: pode ser colado.
//
//   npm run map-fields -- --date 2026-10-15 [--top 20] [--dtcc "data/dtcc/**/*.parquet"]
//   npm run map-fields -- --date 2026-10-15 --map SPREAD_LEG2_TYP=SPRD_LEG2_TYP --map ...   # mapeamento manual
//
// Leitura de cada campo mapeado (sufixo certo e comparação bruta igual à do Spark):
//   pct_found ≈ 100        os breaks do data mart existem no ficheiro DTCC com a mesma chave
//   pct_break_diff ≈ 100   nos breaks, TP1 ≠ TP2
//   pct_nobreak_diff ≈ 0   nas transações sem break neste campo, TP1 = TP2
// pct_break_diff baixo → sufixo errado. pct_nobreak_diff alto → o Spark normaliza (formatos, casas decimais)
// antes de comparar: as regras têm de ver os valores como o Spark os vê.
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { parseArgs } from '../src/cli.js';
import { openDuckDb } from '../src/db/duckdb.js';
import { isValidDate } from '../src/semantic/literals.js';
import { tpPairs, matchFields, dtccSelectSql, confusionSql, confusionRow } from '../src/analysis/fieldmap.js';

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

const db = await openDuckDb(config.source.dbPath);
const t0 = Date.now();
try {
  const src = db.dialect.parquetSource(glob);
  const names = (await db.all(`DESCRIBE SELECT * FROM ${src}`)).map((c) => c.column_name);
  const pairs = tpPairs(names);

  const fields = await db.all(`SELECT UPPER(breaking_field) AS breaking_field, COUNT(*) AS n
FROM breaks WHERE business_date = '${args.date}'
GROUP BY UPPER(breaking_field) ORDER BY n DESC, 1 LIMIT ${top}`);
  if (fields.length === 0) throw new Error(`Sem breaks em ${args.date} na base ${config.source.dbPath}`);

  const matches = matchFields(fields.map((f) => f.breaking_field), pairs, overrides);
  const mapped = matches.filter((m) => m.pair);

  // Tabela temporária só com a chave e os pares necessários (não as 380 colunas).
  await db.exec(`CREATE OR REPLACE TEMP TABLE dtcc AS\n${dtccSelectSql(config, db.dialect, src, args.date, mapped.map((m) => m.pair))}`);
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

  const unmatched = matches.filter((m) => !m.pair);
  if (unmatched.length) {
    console.log('\n== Campos sem par TP com o mesmo nome (confirmar e repetir com --map CAMPO=SUFIXO) ==');
    console.table(unmatched.map((m) => ({ breaking_field: m.field, candidatos: m.candidates.join(', ') || '-' })));
  }
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)} s`);
} catch (err) {
  console.error(`${err.name}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
