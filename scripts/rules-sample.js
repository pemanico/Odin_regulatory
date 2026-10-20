#!/usr/bin/env node
// Amostra de breaks para validação manual do motor de regras (pelos operacionais / Ordep).
//
//   npm run rules:sample -- --date 2026-10-15 [--n 10] [--field VALUATION_CCY]
//
// Escolhe N breaks de break_detail, repartidos pelos veredictos (amostra determinística: o mesmo N e a mesma
// data dão sempre os mesmos breaks), e escreve data/reports/sample-<data>.csv com: chave de produção, campo
// (nome do documento de regras), valor BNPP (TP1_<campo>), valor other cpty (TP2_<campo>), veredicto e o erro
// de format/condition de cada lado, mais duas colunas vazias para a validação (correto S/N, comentário).
// O CSV tem identificadores e valores: fica só no PC. No ecrã aparecem só nº, campo e veredicto.
// Pré-requisito: npm run rules -- --date <data>.
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
  console.error('Uso: npm run rules:sample -- --date YYYY-MM-DD [--n 10] [--field CAMPO]');
  process.exit(1);
}
const D = args.date;
const N = intValue(args.n ?? 10, { min: 1, max: 200 });
const config = loadConfig();

const db = await openDuckDb(config.source.dbPath);
try {
  const fieldFilter = args.field ? ` AND breaking_field = ${stringLiteral(String(args.field).toUpperCase())}` : '';
  const present = new Map((await db.all(`SELECT veredicto, COUNT(*) AS n FROM break_detail
WHERE business_date = '${D}'${fieldFilter} GROUP BY veredicto`)).map((r) => [r.veredicto, Number(r.n)]));
  if (present.size === 0) throw new Error(`Sem detalhe em ${D}: correr primeiro npm run rules -- --date ${D}`);

  // Quotas por veredicto: repartição igual pela ordem de VERDICTS; o resto vai para os primeiros.
  const order = VERDICTS.map((v) => VERDICT_TEXT[v]).filter((t) => present.has(t));
  const base = Math.floor(N / order.length);
  const quota = Object.fromEntries(order.map((t) => [t, base]));
  for (let i = 0; i < N - order.length * base; i++) quota[order[i % order.length]] += 1;

  const keyConcat = POSITION_KEY.map((k) => `COALESCE(${k}, '')`).join(` || '|' || `);
  const picks = [];
  for (const t of order) {
    if (!quota[t]) continue;
    picks.push(...(await db.all(`SELECT * FROM break_detail
WHERE business_date = '${D}' AND veredicto = ${stringLiteral(t)}${fieldFilter}
ORDER BY md5(${keyConcat} || '|' || breaking_field)
LIMIT ${quota[t]}`)));
  }

  const rows = picks.map((p, i) => ({
    n: i + 1,
    business_date: D,
    ...Object.fromEntries(POSITION_KEY.map((k) => [k, p[k]])),
    campo: p.campo,
    valor_bnpp: p.valor_bnpp ?? '',
    valor_other_cpty: p.valor_other_cpty ?? '',
    veredicto: p.veredicto,
    erro_bnpp: p.erro_bnpp ?? '',
    erro_other_cpty: p.erro_other_cpty ?? '',
    validacao_correto_S_N: '',
    comentario: '',
  }));

  const outDir = resolve(ROOT, 'data/reports');
  fs.mkdirSync(outDir, { recursive: true });
  const out = resolve(outDir, `sample-${D}.csv`);
  fs.writeFileSync(out, toCsv(rows, Object.keys(rows[0])));
  console.log(`Amostra de ${rows.length} breaks de ${D}:`);
  console.table(rows.map(({ n, campo, veredicto }) => ({ n, campo, veredicto })));
  console.log(`\nFicheiro para validar (chave e valores — só local, não colar): ${out}`);
  console.log('Validar cada linha contra o ficheiro DTCC e o documento de regras; devolver só "n + correto S/N + motivo".');
} catch (err) {
  console.error(`${err.name}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
