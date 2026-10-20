#!/usr/bin/env node
// Amostra de breaks para validação manual do motor de regras (pelos operacionais / Ordep).
//
//   npm run rules:sample -- --date 2026-10-15 [--n 10] [--field VALUATION_CCY]
//
// Escolhe N breaks de break_verdict, repartidos pelos veredictos (amostra determinística: o mesmo N e a
// mesma data dão sempre os mesmos breaks), e escreve data/reports/sample-<data>.csv com a chave de produção,
// os valores TP1 (BNPP) e TP2 (contraparte) do campo, o veredicto, os códigos VR violados e as regras do campo,
// mais duas colunas vazias para a validação (correto S/N, comentário).
// O CSV tem identificadores e valores: fica só no PC. No ecrã aparecem só nº, campo, veredicto e códigos VR.
// Pré-requisito: npm run rules -- --date <data>.
import fs from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';
import { parseArgs } from '../src/cli.js';
import { openDuckDb } from '../src/db/duckdb.js';
import { isValidDate, intValue, stringLiteral } from '../src/semantic/literals.js';
import { loadRules } from '../src/rules/catalog.js';
import { targetSuffix } from '../src/rules/compile.js';
import { keySelect, VERDICTS } from '../src/rules/sql.js';
import { POSITION_KEY } from '../src/db/model.js';
import { toCsv } from '../src/synthetic/generate.js';

const args = parseArgs(process.argv.slice(2));
if (!isValidDate(args.date)) {
  console.error('Uso: npm run rules:sample -- --date YYYY-MM-DD [--n 10] [--field CAMPO]');
  process.exit(1);
}
const D = args.date;
const N = intValue(args.n ?? 10, { min: 1, max: 200 });
const config = loadConfig();
const { fieldMap, rulesDoc } = loadRules();

const db = await openDuckDb(config.source.dbPath);
try {
  const fieldFilter = args.field ? ` AND breaking_field = ${stringLiteral(String(args.field).toUpperCase())}` : '';
  const present = (await db.all(`SELECT verdict, COUNT(*) AS n FROM break_verdict
WHERE business_date = '${D}'${fieldFilter} GROUP BY verdict`)).filter((r) => Number(r.n) > 0);
  if (present.length === 0) throw new Error(`Sem veredictos em ${D}: correr primeiro npm run rules -- --date ${D}`);

  // Quotas por veredicto: repartição igual, pela ordem de VERDICTS; o resto vai para os primeiros.
  const order = VERDICTS.filter((v) => present.some((p) => p.verdict === v));
  const quota = Object.fromEntries(order.map((v) => [v, Math.floor(N / order.length)]));
  for (let i = 0; i < N - order.length * Math.floor(N / order.length); i++) quota[order[i % order.length]] += 1;

  const keyConcat = POSITION_KEY.map((k) => `COALESCE(${k}, '')`).join(` || '|' || `);
  const picks = [];
  for (const v of order) {
    if (!quota[v]) continue;
    picks.push(...(await db.all(`SELECT * FROM break_verdict
WHERE business_date = '${D}' AND verdict = '${v}'${fieldFilter}
ORDER BY md5(${keyConcat} || '|' || breaking_field)
LIMIT ${quota[v]}`)));
  }

  // Valores TP1/TP2 do campo de cada break, lidos do ficheiro DTCC pela chave.
  const src = db.dialect.parquetSource(config.source.dtccGlob);
  const cols = new Set((await db.all(`DESCRIBE SELECT * FROM ${src}`)).map((c) => String(c.column_name).toUpperCase()));
  const lit = (v) => (v == null ? 'NULL' : stringLiteral(String(v)));
  const rulesOf = (field) =>
    rulesDoc.rules.filter((r) => String(targetSuffix(r, fieldMap) ?? '').toUpperCase() === field)
      .map((r) => `${r.code} (${r.status})`).join('; ');

  const rows = [];
  for (const [i, p] of picks.entries()) {
    const f = p.breaking_field;
    let tp1 = '(coluna inexistente)';
    let tp2 = '(coluna inexistente)';
    if (cols.has(`TP1_${f}`) && cols.has(`TP2_${f}`)) {
      const where = POSITION_KEY.map((k) => `COALESCE(k_${k}, '') = COALESCE(${lit(p[k])}, '')`).join(' AND ');
      const [r] = await db.all(`SELECT CAST("TP1_${f}" AS VARCHAR) AS tp1, CAST("TP2_${f}" AS VARCHAR) AS tp2
FROM (SELECT ${keySelect(config, db.dialect)}, "TP1_${f}", "TP2_${f}" FROM ${src}
      WHERE CAST("${config.columns.business_date}" AS DATE) = '${D}') t
WHERE ${where}`);
      tp1 = r?.tp1 ?? '(vazio)';
      tp2 = r?.tp2 ?? '(vazio)';
    }
    rows.push({
      n: i + 1,
      business_date: D,
      ...Object.fromEntries(POSITION_KEY.map((k) => [k, p[k]])),
      breaking_field: f,
      valor_bnpp_tp1: tp1,
      valor_cpty_tp2: tp2,
      veredicto: p.verdict,
      vr_violadas_bnpp: p.bnpp_codes ?? '',
      vr_violadas_cpty: p.cpty_codes ?? '',
      regras_do_campo: rulesOf(f) || '(nenhuma no ficheiro de regras)',
      validacao_correto_S_N: '',
      comentario: '',
    });
  }

  const outDir = resolve(ROOT, 'data/reports');
  fs.mkdirSync(outDir, { recursive: true });
  const out = resolve(outDir, `sample-${D}.csv`);
  fs.writeFileSync(out, toCsv(rows, Object.keys(rows[0])));
  console.log(`Amostra de ${rows.length} breaks de ${D} (regras ${rulesDoc.version}):`);
  console.table(rows.map(({ n, breaking_field, veredicto, vr_violadas_bnpp, vr_violadas_cpty }) =>
    ({ n, breaking_field, veredicto, vr_violadas_bnpp, vr_violadas_cpty })));
  console.log(`\nFicheiro para validar (chave e valores — só local, não colar): ${out}`);
  console.log('Validar cada linha contra o ficheiro DTCC e o Excel de regras; devolver só "n + correto S/N + motivo".');
} catch (err) {
  console.error(`${err.name}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
