// Valida o SQL standard da semantic layer contra um motor real (SQLite embutido no Node >= 22.13),
// com dados sintéticos e resultados esperados calculados em JavaScript.
// O DuckDB é validado à parte com `npm run synthetic` + `npm run build:db` (ver README).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { openSqlite, sqliteAvailable } from '../src/db/sqlite.js';
import { buildModelStatements } from '../src/db/model.js';
import { generateBreakRows } from '../src/synthetic/generate.js';
import { runMetric } from '../src/semantic/runner.js';
import { profileDate } from '../src/analysis/profile.js';

const available = await sqliteAvailable();
const config = loadConfig();
const C = config.columns;
let db;
let data;

// Chave de produção: REPORT_SUBMITTING_ENTITY, LEIs, UTI, PROPRIETARY (separados), asset class, campo.
const utiOf = (r) => r[C.uti] ?? r[C.proprietary];
const posOf = (r) =>
  [r[C.report_submitting_entity], r[C.cp1_lei], r[C.cp2_lei], r[C.uti], r[C.proprietary], r[C.asset_class]].join('\u0001');
const keyOf = (r) => [r[C.business_date], posOf(r), r[C.breaking_field]].join('\u0001');

/** Expectativas calculadas em JS a partir das linhas geradas. */
function expectations(rows) {
  const firstByKey = new Map();
  const pairsByKey = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!firstByKey.has(k) || r[C.rec_stat_id] < firstByKey.get(k)[C.rec_stat_id]) firstByKey.set(k, r);
    const pairs = pairsByKey.get(k) ?? new Set();
    pairs.add(`${r[C.bnpp_value] ?? '<NULL>'}|${r[C.cpty_value] ?? '<NULL>'}`);
    pairsByKey.set(k, pairs);
  }
  const distinct = [...firstByKey.values()];
  return { distinct, pairsByKey };
}

const audit = false;
const onDate = (value) => [{ dimension: 'business_date', op: 'eq', value }];

before(async () => {
  if (!available) return;
  data = generateBreakRows({ columns: C, days: 3, positionsPerDay: 800, seed: 7 });
  db = await openSqlite();
  const cols = Object.values(C);
  await db.exec(
    `CREATE TABLE src_breaks (${cols.map((c) => `"${c}" ${c === C.rec_stat_id ? 'INTEGER' : 'TEXT'}`).join(', ')})`,
  );
  const insert = db.raw.prepare(`INSERT INTO src_breaks (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  db.raw.exec('BEGIN');
  for (const r of data.rows) insert.run(...cols.map((c) => r[c] ?? null));
  db.raw.exec('COMMIT');
  for (const sql of buildModelStatements(config, db.dialect, 'src_breaks', { materialize: true })) await db.exec(sql);
});

after(async () => db?.close());

test('dados sintéticos contêm duplicados, conflitos e LEIs iguais', { skip: !available && 'node:sqlite indisponível' }, () => {
  const { distinct, pairsByKey } = expectations(data.rows);
  assert.ok(data.rows.length > distinct.length, 'deve haver duplicação');
  assert.ok([...pairsByKey.values()].some((s) => s.size > 1), 'deve haver conflitos');
  assert.ok(distinct.some((r) => r[C.cp1_lei] === r[C.cp2_lei]), 'deve haver LEI CP1 = LEI CP2');
});

test('data_quality bate certo com o cálculo em JS', { skip: !available && 'node:sqlite indisponível' }, async () => {
  const [d0, , d2] = data.dates;
  const { rows } = await runMetric(
    db,
    { metric: 'data_quality', filters: [{ dimension: 'business_date', op: 'between', value: [d0, d2] }] },
    { audit },
  );
  assert.equal(rows.length, 3);
  const { distinct, pairsByKey } = expectations(data.rows);
  for (const row of rows) {
    const date = row.business_date;
    const raw = data.rows.filter((r) => r[C.business_date] === date).length;
    const dist = distinct.filter((r) => r[C.business_date] === date);
    const conflicts = [...pairsByKey.entries()].filter(([k, s]) => k.startsWith(date) && s.size > 1).length;
    assert.equal(Number(row.raw_rows), raw, `raw_rows ${date}`);
    assert.equal(Number(row.distinct_breaks), dist.length, `distinct_breaks ${date}`);
    assert.equal(Number(row.distinct_positions), new Set(dist.map(posOf)).size, `distinct_positions ${date}`);
    assert.equal(Number(row.conflicting_keys), conflicts, `conflicting_keys ${date}`);
    assert.ok(row.dup_factor > 1);
  }
});

test('top_fields devolve os 10 campos com mais breaks distintos, por ordem', { skip: !available && 'node:sqlite indisponível' }, async () => {
  const date = data.dates[1];
  const { rows } = await runMetric(db, { metric: 'top_fields', filters: onDate(date) }, { audit });
  const counts = new Map();
  for (const r of expectations(data.rows).distinct.filter((r) => r[C.business_date] === date)) {
    counts.set(r[C.breaking_field], (counts.get(r[C.breaking_field]) ?? 0) + 1);
  }
  const expected = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10);
  assert.deepEqual(rows.map((r) => [r.breaking_field, Number(r.n_breaks)]), expected);
});

test('breaks_dod compara com a business date anterior disponível', { skip: !available && 'node:sqlite indisponível' }, async () => {
  const [d0, d1] = data.dates;
  const { rows } = await runMetric(db, { metric: 'breaks_dod', filters: onDate(d1), limit: 100 }, { audit });
  const { distinct } = expectations(data.rows);
  const count = (date, field) => distinct.filter((r) => r[C.business_date] === date && r[C.breaking_field] === field).length;
  for (const row of rows) {
    assert.equal(row.previous_date, d0);
    assert.equal(Number(row.today), count(d1, row.breaking_field));
    assert.equal(Number(row.previous), count(d0, row.breaking_field));
    assert.equal(Number(row.delta), Number(row.today) - Number(row.previous));
  }
  // Primeiro dia: sem dia anterior, previous = 0 e delta_pct = null.
  const first = await runMetric(db, { metric: 'breaks_dod', filters: onDate(d0) }, { audit });
  assert.ok(first.rows.every((r) => Number(r.previous) === 0 && r.delta_pct === null));
});

test('breaks_by_counterparty com filtro por campo', { skip: !available && 'node:sqlite indisponível' }, async () => {
  const date = data.dates[2];
  const { rows } = await runMetric(
    db,
    {
      metric: 'breaks_by_counterparty',
      filters: [...onDate(date), { dimension: 'breaking_field', op: 'eq', value: 'VALUATION_AMT' }],
      limit: 5,
    },
    { audit },
  );
  const counts = new Map();
  for (const r of expectations(data.rows).distinct) {
    if (r[C.business_date] !== date || r[C.breaking_field] !== 'VALUATION_AMT') continue;
    counts.set(r[C.cp2_lei], (counts.get(r[C.cp2_lei]) ?? 0) + 1);
  }
  const expected = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
  assert.deepEqual(rows.map((r) => [r.cp2_lei, Number(r.n_breaks)]), expected);
});

test('profile: combinações de campos cobrem todas as positions', { skip: !available && 'node:sqlite indisponível' }, async () => {
  const date = data.dates[0];
  const p = await profileDate(db, date, { combos: 1000 });
  const positions = new Set(expectations(data.rows).distinct.filter((r) => r[C.business_date] === date).map(posOf));
  assert.equal(p.combosCoverPositions, positions.size);
  assert.ok(p.combinations.some((c) => c.fields === 'PCKG_TRANS_SPREAD,PCKG_TRANS_SPREAD_CCY,PCKG_TRANS_SPREAD_TYP'));
  assert.ok(Number(p.keyHealth.same_lei) > 0);
  assert.ok(Number(p.duplicated[0].n_trade_numbers) > 1, 'fan-out deve aparecer como vários trade numbers');
});

test('UTI nulo usa PROPRIETARY e não colapsa trades diferentes', { skip: !available && 'node:sqlite indisponível' }, async () => {
  const date = data.dates[0];
  const viaAlt = data.rows.filter((r) => r[C.business_date] === date && r[C.uti] == null);
  assert.ok(viaAlt.length > 0, 'os dados sintéticos devem ter linhas só com PROPRIETARY');
  const [health] = await db.all(
    `SELECT COUNT(*) AS n FROM breaks WHERE business_date = '${date}' AND uti IS NULL AND proprietary IS NULL`,
  );
  assert.equal(Number(health.n), 0, 'nenhum break fica sem identificador');
  const expected = new Set(expectations(viaAlt).distinct.map(posOf)).size;
  const [got] = await db.all(
    `SELECT COUNT(*) AS n FROM (SELECT DISTINCT proprietary, cp1_lei, cp2_lei FROM breaks WHERE business_date = '${date}' AND proprietary LIKE 'SYNTHPRP%') p`,
  );
  assert.equal(Number(got.n), expected, 'cada trade só com PROPRIETARY é uma position própria');
});

// ---- persistence (aprovada em 2026-10-19) ----

/** Breaks distintos de uma data, indexados pela chave sem data. */
function breaksOn(date) {
  const m = new Map();
  for (const r of expectations(data.rows).distinct) {
    if (r[C.business_date] !== date) continue;
    m.set([posOf(r), r[C.breaking_field]].join('\u0001'), r);
  }
  return m;
}

/** Classificação esperada em JS: { field -> { igual, alterado, novo, resolvido } } e o total. */
function expectedPersistence(date, prevDate, { assetClass } = {}) {
  const cur = breaksOn(date);
  const pre = breaksOn(prevDate);
  const byField = new Map();
  const total = { igual: 0, alterado: 0, novo: 0, resolvido: 0 };
  const add = (r, status) => {
    if (assetClass && r[C.asset_class] !== assetClass) return;
    const f = r[C.breaking_field];
    const e = byField.get(f) ?? { igual: 0, alterado: 0, novo: 0, resolvido: 0 };
    e[status]++;
    total[status]++;
    byField.set(f, e);
  };
  for (const [k, r] of cur) {
    const p = pre.get(k);
    if (!p) add(r, 'novo');
    else if ((r[C.bnpp_value] ?? null) === (p[C.bnpp_value] ?? null) && (r[C.cpty_value] ?? null) === (p[C.cpty_value] ?? null)) add(r, 'igual');
    else add(r, 'alterado');
  }
  for (const [k, p] of pre) if (!cur.has(k)) add(p, 'resolvido');
  return { byField, total };
}

const skipNoSqlite = !available && 'node:sqlite indisponível';

test('persistence: os 4 grupos batem certo com o cálculo em JS (total e por campo)', { skip: skipNoSqlite }, async () => {
  const [d0, d1] = data.dates;
  const exp = expectedPersistence(d1, d0);
  for (const s of ['igual', 'alterado', 'novo', 'resolvido']) assert.ok(exp.total[s] > 0, `o sintético deve ter breaks "${s}"`);

  const { rows: [tot] } = await runMetric(db, { metric: 'persistence', filters: onDate(d1) }, { audit });
  assert.equal(tot.previous_date, d0);
  for (const s of ['igual', 'alterado', 'novo', 'resolvido']) assert.equal(tot[s], exp.total[s], s);
  assert.equal(tot.breaks_today, exp.total.igual + exp.total.alterado + exp.total.novo);
  assert.equal(tot.breaks_previous, exp.total.igual + exp.total.alterado + exp.total.resolvido);
  assert.equal(tot.pct_igual, Math.round((exp.total.igual / tot.breaks_today) * 1000) / 10);

  const { rows } = await runMetric(db, { metric: 'persistence', filters: onDate(d1), dimensions: ['breaking_field'] }, { audit });
  assert.equal(rows.length, exp.byField.size);
  for (const r of rows) {
    const e = exp.byField.get(r.breaking_field);
    for (const s of ['igual', 'alterado', 'novo', 'resolvido']) assert.equal(r[s], e[s], `${r.breaking_field} ${s}`);
  }
});

test('persistence: NULL = NULL conta como igual', { skip: skipNoSqlite }, async () => {
  const [d0, d1] = data.dates;
  const cur = breaksOn(d1);
  const pre = breaksOn(d0);
  const nullIguais = [...cur].filter(([k, r]) => {
    const p = pre.get(k);
    return p && r[C.cpty_value] == null && p[C.cpty_value] == null && r[C.bnpp_value] === p[C.bnpp_value];
  });
  assert.ok(nullIguais.length > 0, 'o sintético deve ter breaks iguais com CPTY nulo');
  // Se NULL ≠ NULL, estes breaks sairiam como "alterado" e o total de iguais não bateria (teste anterior).
});

test('persistence: filtro por dimensão usa o valor de D (D-1 nos resolvidos)', { skip: skipNoSqlite }, async () => {
  const [d0, d1] = data.dates;
  const exp = expectedPersistence(d1, d0, { assetClass: 'CREDIT' });
  const { rows: [tot] } = await runMetric(
    db,
    { metric: 'persistence', filters: [...onDate(d1), { dimension: 'asset_class', op: 'eq', value: 'CREDIT' }] },
    { audit },
  );
  for (const s of ['igual', 'alterado', 'novo', 'resolvido']) assert.equal(tot[s], exp.total[s], s);
});

test('persistence: datas excluídas são saltadas; primeira data não tem comparação', { skip: skipNoSqlite }, async () => {
  const [d0, d1, d2] = data.dates;
  const exp = expectedPersistence(d2, d0);
  const { rows: [tot] } = await runMetric(db, { metric: 'persistence', filters: onDate(d2) }, { audit, excludedDates: [d1] });
  assert.equal(tot.previous_date, d0);
  for (const s of ['igual', 'alterado', 'novo', 'resolvido']) assert.equal(tot[s], exp.total[s], s);

  const first = await runMetric(db, { metric: 'persistence', filters: onDate(d0) }, { audit });
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].previous_date, null);
  assert.equal(first.rows[0].breaks_today, breaksOn(d0).size);
  assert.equal(first.rows[0].pct_igual, null);
  assert.equal(first.rows[0].novo, null, 'sem dia anterior não é "100% novo"');

  const dod = await runMetric(db, { metric: 'breaks_dod', filters: onDate(d2) }, { audit, excludedDates: [d1] });
  assert.ok(dod.rows.every((r) => r.previous_date === d0));

  const none = await runMetric(db, { metric: 'persistence', filters: onDate('2030-01-02') }, { audit });
  assert.equal(none.rows.length, 0, 'data sem dados não devolve tudo como resolvido');
});

test('profile: mudança de identificador (PROPRIETARY -> UTI) é contada', { skip: skipNoSqlite }, async () => {
  const [d0, d1] = data.dates;
  const p = await profileDate(db, d1);
  const posKeys = (date) => new Set(expectations(data.rows).distinct.filter((r) => r[C.business_date] === date).map(posOf));
  const prevTrades = new Map();
  for (const r of expectations(data.rows).distinct.filter((r) => r[C.business_date] === d0)) {
    prevTrades.set([r[C.cp1_lei], r[C.cp2_lei], r[C.trade_number]].join('|'), utiOf(r));
  }
  const prevPos = posKeys(d0);
  const newPos = new Map();
  for (const r of expectations(data.rows).distinct.filter((r) => r[C.business_date] === d1)) {
    if (!prevPos.has(posOf(r))) newPos.set(posOf(r), r);
  }
  const changed = [...newPos.values()].filter((r) => {
    const u = prevTrades.get([r[C.cp1_lei], r[C.cp2_lei], r[C.trade_number]].join('|'));
    return u !== undefined && u !== utiOf(r);
  }).length;
  assert.equal(p.idChange.previous_date, d0);
  assert.equal(Number(p.idChange.new_positions), newPos.size);
  assert.ok(changed > 0, 'o sintético deve ter trades que passam de PROPRIETARY para UTI');
  assert.equal(Number(p.idChange.id_changed_positions), changed);
});
