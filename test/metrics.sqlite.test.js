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

const keyOf = (r) => [r[C.business_date], r[C.uti], r[C.cp1_lei], r[C.cp2_lei], r[C.breaking_field]].join('\u0001');
const posOf = (r) => [r[C.uti], r[C.cp1_lei], r[C.cp2_lei]].join('\u0001');

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
