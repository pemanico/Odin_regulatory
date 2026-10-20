import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tpPairs, matchFields, confusionSql, confusionRow, dtccSelectSql, explainSql } from '../src/analysis/fieldmap.js';
import { openSqlite, sqliteAvailable } from '../src/db/sqlite.js';
import { loadConfig } from '../src/config.js';

const COLS = ['UTI', 'TP1_VALUATION_AMT', 'TP2_VALUATION_AMT', 'TP1_ISIN', 'TP2_ISIN', 'TP1_SPRD_LEG2_TYP', 'TP2_SPRD_LEG2_TYP', 'TP1_ONLY'];

test('tpPairs só aceita pares completos TP1_/TP2_', () => {
  assert.deepEqual(tpPairs(COLS).map((p) => p.suffix), ['VALUATION_AMT', 'ISIN', 'SPRD_LEG2_TYP']);
});

test('matchFields: nome igual (ignora maiúsculas), override, e candidatos sem escolha automática', () => {
  const pairs = tpPairs(COLS);
  const m = matchFields(['valuation_amt', 'ISIN', 'SPREAD_LEG2_TYP', 'FOO'], pairs, { ISIN: 'VALUATION_AMT' });
  assert.equal(m[0].pair.suffix, 'VALUATION_AMT');
  assert.equal(m[0].how, 'nome igual');
  assert.equal(m[1].how, 'override');
  assert.equal(m[1].pair.suffix, 'VALUATION_AMT');
  assert.equal(m[2].pair, null, 'nome diferente nunca é mapeado automaticamente');
  assert.equal(m[2].candidates[0], 'SPRD_LEG2_TYP');
  assert.deepEqual(m[3].candidates, []);
  assert.throws(() => matchFields(['ISIN'], pairs, { ISIN: 'NAO_EXISTE' }), /Override inválido/);
});

test('dtccSelectSql traz só a chave normalizada e os pares pedidos', () => {
  const config = loadConfig();
  const sql = dtccSelectSql(config, { castText: (e) => `CAST(${e} AS VARCHAR)`, castDate: (e) => `CAST(${e} AS DATE)` },
    'src', '2026-10-15', tpPairs(COLS).slice(0, 1));
  assert.match(sql, /NULLIF\(TRIM\(CAST\("PROPRIETARY" AS VARCHAR\)\), ''\) AS proprietary/);
  assert.match(sql, /CAST\("TP1_VALUATION_AMT" AS VARCHAR\) AS tp1_0/);
  assert.doesNotMatch(sql, /ISIN/);
  assert.match(sql, /WHERE CAST\("BUSINESS_DATE" AS DATE\) = '2026-10-15'/);
});

test('confusionSql: matriz de confusão por campo (NULL vs valor conta como diferente)', { skip: !(await sqliteAvailable()) && 'node:sqlite indisponível' }, async () => {
  const db = await openSqlite();
  const key = 'report_submitting_entity TEXT, cp1_lei TEXT, cp2_lei TEXT, uti TEXT, proprietary TEXT, asset_class TEXT';
  await db.exec(`CREATE TABLE breaks (business_date TEXT, ${key}, breaking_field TEXT)`);
  await db.exec(`CREATE TABLE dtcc (${key}, tp1_0 TEXT, tp2_0 TEXT, st_0 TEXT)`);
  const k = (id, prop = null) => `'E','A','B',${id ? `'${id}'` : 'NULL'},${prop ? `'${prop}'` : 'NULL'},'CREDIT'`;
  // 3 breaks no campo: 2 com TP1 ≠ TP2 (um deles NULL vs valor), 1 com TP1 = TP2; 1 break que não existe no DTCC.
  for (const [id, prop] of [['U1'], ['U2'], [null, 'P3'], ['U9']]) {
    await db.exec(`INSERT INTO breaks VALUES ('2026-10-15', ${k(id, prop)}, 'valuation_amt')`);
  }
  await db.exec(`INSERT INTO breaks VALUES ('2026-10-14', ${k('U4')}, 'valuation_amt')`); // outro dia: ignorado
  await db.exec(`INSERT INTO breaks VALUES ('2026-10-15', ${k('U4')}, 'isin')`); // outro campo: ignorado
  const dt = [
    [k('U1'), "'1'", "'2'"],
    [k('U2'), "'1'", 'NULL'],
    [k(null, 'P3'), "'5'", "'5'"],
    [k('U4'), "'7'", "'8'"], // sem break neste campo, mas diferente
    [k('U5'), "'7'", "'7'"],
    [k('U6'), 'NULL', 'NULL'], // NULL = NULL → igual
  ];
  for (const [kk, a, b] of dt) await db.exec(`INSERT INTO dtcc VALUES (${kk}, ${a}, ${b}, ${kk.includes('U4') ? "'NOAP'" : "'RECO'"})`);

  const [r] = await db.all(confusionSql('2026-10-15', 'VALUATION_AMT', 0));
  const row = confusionRow(r);
  assert.deepEqual(
    { n: row.n_breaks, f: row.breaks_found, bd: row.break_diff, be: row.break_equal, nd: row.nobreak_diff, ne: row.nobreak_equal },
    { n: 4, f: 3, bd: 2, be: 1, nd: 1, ne: 2 },
  );
  assert.equal(row.pct_found, 75);
  assert.equal(row.pct_break_diff, 66.7);
  assert.equal(row.pct_nobreak_diff, 33.3);

  // explain: a diferença sem break (U4) aparece isolada no estado NOAP.
  const ex = await db.all(explainSql('2026-10-15', 'VALUATION_AMT', 0, 1));
  const byStatus = Object.fromEntries(ex.map((r) => [r.st_0, r]));
  assert.equal(Number(byStatus.NOAP.nobreak_diff), 1);
  assert.equal(Number(byStatus.RECO.nobreak_diff), 0);
  assert.equal(Number(byStatus.RECO.break_diff), 2);
  await db.close();
});
