// key_summary, métricas key_verdict / field_combinations e API (sem Express), sobre SQLite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite, sqliteAvailable } from '../src/db/sqlite.js';
import { VERDICT_DDL, DETAIL_DDL, KEY_SUMMARY_DDL, insertKeySummarySql } from '../src/rules/sql.js';
import { createDbPool, DbBusyError, isLockError } from '../src/server/dbpool.js';
import { createApi, statusFor, keysQuery } from '../src/server/api.js';
import { AGENT_TOOLS } from '../src/server/tools.js';
import { ValidationError } from '../src/semantic/literals.js';

const skip = !(await sqliteAvailable()) && 'node:sqlite indisponível';
const D = '2026-10-15';
const KEY = ['report_submitting_entity', 'cp1_lei', 'cp2_lei', 'uti', 'proprietary', 'asset_class'];

// [uti, proprietary, cp2, asset class, campo, veredicto]
const BREAKS = [
  ['U1', null, 'B', 'CURR', 'DELIVERY_TYPE', 'so_bnpp'],
  ['U1', null, 'B', 'CURR', 'VALUATION_AMT', 'divergencia'],
  [null, 'P2', 'B', 'CURR', 'ISIN', 'so_contraparte'],
  [null, 'P2', 'B', 'CURR', 'UNIQUE_PRODUCT_ID', 'ambos'],
  [null, 'P2', 'B', 'CURR', 'VALUATION_AMT', 'sem_regras_verificaveis'],
  ['U3', null, 'B', 'CURR', 'VALUATION_AMT', 'divergencia'],
  ['U4', null, 'C', 'EQ', 'VALUATIONXAMT', 'divergencia'], // o _ do LIKE não pode apanhar este campo
  ['U5', null, 'C', 'EQ', 'ISIN', 'so_contraparte'],
];

async function fixture() {
  const db = await openSqlite();
  await db.exec(VERDICT_DDL);
  await db.exec(DETAIL_DDL);
  const lit = (x) => (x == null ? 'NULL' : `'${String(x).replace(/'/g, "''")}'`);
  for (const [uti, prop, cp2, ac, field, verdict] of BREAKS) {
    const key = ['E', 'A', cp2, uti, prop, ac].map(lit).join(', ');
    await db.exec(`INSERT INTO break_verdict VALUES ('${D}', ${key}, '${field}', 1, 0, 0, NULL, NULL, '${verdict}', 'v1')`);
    await db.exec(`INSERT INTO break_detail VALUES ('${D}', ${key}, '2.x ${field}', '${field}', 'b-${field}', 'c-${field}',
      'texto ${verdict}', NULL, NULL, 'v1')`);
  }
  await db.exec(KEY_SUMMARY_DDL);
  await db.exec(insertKeySummarySql(D, db.dialect, 'v1'));
  return db;
}

async function apiFor(db, events = []) {
  const pool = createDbPool(async () => db, { keepOpen: true });
  return createApi(pool, { excludedDates: [], audit: (e) => events.push(e) });
}

test('key_summary: uma linha por Key, combinação ordenada e veredicto da Key', { skip }, async () => {
  const db = await fixture();
  const rows = await db.all(`SELECT key_id, uti, proprietary, n_fields, combo, key_verdict FROM key_summary ORDER BY key_id`);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], {
    key_id: 1, uti: null, proprietary: 'P2', n_fields: 3, combo: '|ISIN|UNIQUE_PRODUCT_ID|VALUATION_AMT|', key_verdict: 'misto',
  });
  const by = Object.fromEntries(rows.map((r) => [r.uti ?? r.proprietary, r.key_verdict]));
  assert.deepEqual(by, { P2: 'misto', U1: 'bnpp', U3: 'sem_explicacao', U4: 'sem_explicacao', U5: 'contraparte' });
  assert.equal(rows[1].combo, '|DELIVERY_TYPE|VALUATION_AMT|');
  await db.close();
});

test('métricas key_verdict e field_combinations (filtro por campo contido na combinação)', { skip }, async () => {
  const db = await fixture();
  const api = await apiFor(db);
  const f = [{ dimension: 'business_date', op: 'eq', value: D }];
  const kv = await api.queryMetric({ metric: 'key_verdict', filters: f });
  assert.deepEqual(Object.fromEntries(kv.rows.map((r) => [r.key_verdict, Number(r.n_keys)])),
    { sem_explicacao: 2, misto: 1, bnpp: 1, contraparte: 1 });
  const combos = await api.queryMetric({
    metric: 'field_combinations', filters: [...f, { dimension: 'breaking_field', op: 'eq', value: 'valuation_amt' }],
  });
  assert.deepEqual(combos.rows.map((r) => [r.combo, Number(r.n_keys)]), [
    ['DELIVERY_TYPE + VALUATION_AMT', 1], ['ISIN + UNIQUE_PRODUCT_ID + VALUATION_AMT', 1], ['VALUATION_AMT', 1],
  ], 'VALUATIONXAMT não entra (o _ é escapado no LIKE); minúsculas aceites');
  assert.equal(combos.rows[0].combo_key, '|DELIVERY_TYPE|VALUATION_AMT|');
  await assert.rejects(
    api.queryMetric({ metric: 'field_combinations', filters: [...f, { dimension: 'breaking_field', op: 'eq', value: "X%' OR 1=1 --" }] }),
    ValidationError,
  );
  // breaking_field sem distinção de maiúsculas nas outras métricas
  const rv = await api.queryMetric({ metric: 'rule_verdict', filters: [...f, { dimension: 'breaking_field', op: 'eq', value: 'isin' }] });
  assert.deepEqual(rv.rows.map((r) => [r.verdict, Number(r.n_breaks)]), [['so_contraparte', 2]]);
  await db.close();
});

test('API keys: filtros, veredicto do campo, paginação e pesquisa por identificador', { skip }, async () => {
  const db = await fixture();
  const events = [];
  const api = await apiFor(db, events);
  const all = await api.listKeys({ date: D });
  assert.equal(all.total, 5);
  assert.deepEqual(all.rows.map((r) => r.trade_id), ['P2', 'U1', 'U3', 'U4', 'U5']);
  assert.equal(all.rows[0].trade_id_type, 'PROPRIETARY');
  assert.deepEqual(all.rows[0].fields, ['ISIN', 'UNIQUE_PRODUCT_ID', 'VALUATION_AMT']);

  const byField = await api.listKeys({ date: D, field: 'valuation_amt' });
  assert.deepEqual(byField.rows.map((r) => [r.trade_id, r.field_verdict]),
    [['P2', 'sem_regras_verificaveis'], ['U1', 'divergencia'], ['U3', 'divergencia']]);
  const div = await api.listKeys({ date: D, field: 'VALUATION_AMT', field_verdict: 'divergencia', sort: 'fields_asc' });
  assert.deepEqual(div.rows.map((r) => r.trade_id), ['U3', 'U1']);
  assert.equal((await api.listKeys({ date: D, combo: '|ISIN|' })).rows[0].trade_id, 'U5');
  assert.equal((await api.listKeys({ date: D, key_verdict: 'misto' })).total, 1);
  assert.equal((await api.listKeys({ date: D, asset_class: 'EQ', min_fields: 1 })).total, 2);
  assert.equal((await api.listKeys({ date: D, trade: 'U' })).total, 4);
  const p2 = await api.listKeys({ date: D, page: 2, page_size: 2 });
  assert.deepEqual([p2.total, p2.rows.map((r) => r.trade_id)], [5, ['U3', 'U4']]);

  for (const bad of [{}, { date: D, sort: 'x; DROP' }, { date: D, field_verdict: 'so_bnpp' }, { date: D, combo: "|A|' OR 1=1" },
    { date: D, page_size: 1000 }, { date: D, trade: "U1' --" }]) {
    await assert.rejects(api.listKeys(bad), ValidationError, JSON.stringify(bad));
  }
  // Auditoria sem linhas de dados: só parâmetros e contagem.
  const ok = events.find((e) => e.endpoint === 'keys' && e.status === 'ok');
  assert.ok(ok && 'rowCount' in ok && !('rows' in ok));
  await db.close();
});

test('API key: todos os breaks da Key com valores TP1/TP2 e veredicto', { skip }, async () => {
  const db = await fixture();
  const api = await apiFor(db);
  const { key, breaks } = await api.getKey('1', { date: D });
  assert.equal(key.trade_id, 'P2');
  assert.deepEqual(breaks.map((b) => [b.breaking_field, b.valor_bnpp, b.valor_other_cpty, b.verdict]), [
    ['ISIN', 'b-ISIN', 'c-ISIN', 'so_contraparte'],
    ['UNIQUE_PRODUCT_ID', 'b-UNIQUE_PRODUCT_ID', 'c-UNIQUE_PRODUCT_ID', 'ambos'],
    ['VALUATION_AMT', 'b-VALUATION_AMT', 'c-VALUATION_AMT', 'sem_regras_verificaveis'],
  ]);
  await assert.rejects(api.getKey('99', { date: D }), (e) => statusFor(e) === 404);
  await assert.rejects(api.getKey('1', {}), ValidationError);
  await db.close();
});

test('API meta: datas com regras e jurisdições (só EMIR ativa); base sem key_summary dá dica', { skip }, async () => {
  const db = await fixture();
  const meta = await (await apiFor(db)).meta();
  assert.deepEqual(meta.dates, [{ date: D, rulesVersion: 'v1' }]);
  assert.deepEqual(meta.jurisdictions.filter((j) => j.enabled).map((j) => j.id), ['EMIR']);
  await db.close();
  const empty = await openSqlite();
  const m2 = await (await apiFor(empty)).meta();
  assert.deepEqual(m2.dates, []);
  assert.match(m2.hint, /npm run rules/);
  await empty.close();
});

test('pool: ligação curta (fecha sem pedidos) e erro de lock -> 503', async () => {
  let opened = 0;
  let closed = 0;
  const pool = createDbPool(async () => {
    opened += 1;
    return { all: async () => [], close: async () => { closed += 1; } };
  });
  await Promise.all([pool.with(async () => 1), pool.with(async () => 2)]);
  assert.equal(opened, 1, 'pedidos simultâneos partilham a ligação');
  assert.equal(closed, 1, 'fecha quando não há pedidos em curso');
  await pool.with(async () => 3);
  assert.equal(opened, 2);
  const busy = createDbPool(async () => { throw new Error('IO Error: Could not set lock on file'); });
  await assert.rejects(busy.with(async () => 0), (e) => e instanceof DbBusyError && statusFor(e) === 503);
  assert.equal(isLockError(new Error('Catalog Error')), false);
});

test('tools do agente: nenhuma tool devolve linhas; keysQuery só com literais validados', () => {
  assert.deepEqual(AGENT_TOOLS.map((t) => t.name), ['list_metrics', 'query_metric', 'open_drilldown']);
  assert.ok(!AGENT_TOOLS.some((t) => /keys/.test(t.name)));
  const q = keysQuery({ date: D, field: 'isin', field_verdict: 'so_contraparte' });
  assert.match(q.join, /bv\.breaking_field = 'ISIN'/);
  assert.equal(statusFor(new ValidationError('x')), 400);
});

test('perguntas sugeridas: todas compilam (conjunto de teste do agente)', async () => {
  const { compileMetric } = await import('../src/semantic/compiler.js');
  const api = createApi(createDbPool(async () => ({})), { audit: false });
  const qs = api.questions();
  assert.ok(qs.length >= 10);
  for (const q of qs) {
    const req = JSON.parse(JSON.stringify(q.request).replaceAll('$date', D));
    assert.doesNotThrow(() => compileMetric(req), q.id);
  }
});
