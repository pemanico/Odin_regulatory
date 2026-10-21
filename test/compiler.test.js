import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileMetric, MetricUnavailableError } from '../src/semantic/compiler.js';
import { ValidationError } from '../src/semantic/literals.js';
import { describeCatalog } from '../src/semantic/catalog.js';

const onDate = (value = '2026-10-15') => [{ dimension: 'business_date', op: 'eq', value }];

test('catalog has the 6 metrics of the plan + persistence, rule_verdict, key_verdict and field_combinations, with reference_id_distribution pending', () => {
  const cat = describeCatalog();
  assert.deepEqual(
    cat.metrics.map((m) => m.id).sort(),
    ['breaks_by_counterparty', 'breaks_by_field', 'breaks_dod', 'data_quality', 'field_combinations', 'key_verdict', 'persistence',
      'reference_id_distribution', 'rule_verdict', 'top_fields'],
  );
  assert.equal(cat.metrics.find((m) => m.id === 'reference_id_distribution').available, false);
});

test('unknown metric and pending metric are rejected', () => {
  assert.throws(() => compileMetric({ metric: 'drop_table', filters: onDate() }), ValidationError);
  assert.throws(() => compileMetric({ metric: 'reference_id_distribution' }), MetricUnavailableError);
});

test('top_fields compiles with default limit 10 and deduplicated grain', () => {
  const { sql } = compileMetric({ metric: 'top_fields', filters: onDate() });
  assert.match(sql, /FROM breaks\n/);
  assert.match(sql, /business_date = '2026-10-15'/);
  assert.match(sql, /LIMIT 10$/);
});

test('missing required filter', () => {
  assert.throws(() => compileMetric({ metric: 'top_fields' }), /Missing required filter/);
});

test('filter values are escaped (no injection)', () => {
  const { sql } = compileMetric({
    metric: 'breaks_by_field',
    filters: [...onDate(), { dimension: 'cp2_lei', op: 'eq', value: "X' OR 1=1 --" }],
  });
  assert.match(sql, /cp2_lei = 'X'' OR 1=1 --'/);
});

test('dimensions and filters outside the whitelist are rejected', () => {
  assert.throws(
    () => compileMetric({ metric: 'top_fields', filters: onDate(), dimensions: ['cp2_lei'] }),
    /Dimension not allowed/,
  );
  assert.throws(
    () => compileMetric({ metric: 'breaks_by_field', filters: [...onDate(), { dimension: 'bnpp_value', op: 'eq', value: 'x' }] }),
    /Filter not allowed/,
  );
  assert.throws(
    () => compileMetric({ metric: 'breaks_by_field', filters: onDate(), dimensions: ['breaking_field; DROP TABLE breaks'] }),
    /Dimension not allowed/,
  );
});

test('invalid dates, inverted ranges and out-of-range limits', () => {
  assert.throws(() => compileMetric({ metric: 'top_fields', filters: onDate('2026-02-30') }), /Invalid date/);
  assert.throws(
    () => compileMetric({ metric: 'top_fields', filters: [{ dimension: 'business_date', op: 'between', value: ['2026-10-15', '2026-10-12'] }] }),
    /Inverted/,
  );
  assert.throws(() => compileMetric({ metric: 'top_fields', filters: onDate(), limit: 0 }), /Invalid integer/);
  assert.throws(() => compileMetric({ metric: 'top_fields', filters: onDate(), limit: 'all' }), /Invalid integer/);
});

test('breaks_dod requires business_date with eq', () => {
  assert.throws(
    () => compileMetric({ metric: 'breaks_dod', filters: [{ dimension: 'business_date', op: 'between', value: ['2026-10-12', '2026-10-15'] }] }),
    /only accepts: eq/,
  );
  const { sql } = compileMetric({ metric: 'breaks_dod', filters: onDate() });
  assert.match(sql, /business_date < '2026-10-15'/);
});

test('"in" filter validates the list', () => {
  assert.throws(
    () => compileMetric({ metric: 'breaks_by_field', filters: [...onDate(), { dimension: 'breaking_field', op: 'in', value: [] }] }),
    /list/,
  );
  const { sql } = compileMetric({
    metric: 'breaks_by_field',
    filters: [...onDate(), { dimension: 'breaking_field', op: 'in', value: ['isin', 'VALUATION_AMT'] }],
  });
  // breaking_field is compared case-insensitively (lower case in the data mart, upper case in break_verdict).
  assert.match(sql, /UPPER\(breaking_field\) IN \('ISIN', 'VALUATION_AMT'\)/);
});

test('profile: redactIds removes UTI and LEIs and keeps the aggregates', async () => {
  const { redactIds } = await import('../src/analysis/profile.js');
  const [row] = redactIds([{ uti: 'X', cp1_lei: 'A', cp2_lei: 'B', raw_rows: 3, n_fields: 2, n_trade_numbers: 1 }]);
  assert.deepEqual(row, { raw_rows: 3, n_fields: 2, n_trade_numbers: 1 });
});

test('excluded dates: skipped as previous day and rejected as requested date', () => {
  const excludedDates = ['2026-10-12'];
  for (const metric of ['breaks_dod', 'persistence']) {
    const { sql } = compileMetric({ metric, filters: onDate('2026-10-13') }, { excludedDates });
    assert.match(sql, /business_date < '2026-10-13' AND business_date NOT IN \('2026-10-12'\)/);
    assert.throws(() => compileMetric({ metric, filters: onDate('2026-10-12') }, { excludedDates }), /excluded/);
  }
  // Without excluded dates, the previous behaviour is kept.
  const { sql } = compileMetric({ metric: 'breaks_dod', filters: onDate('2026-10-13') });
  assert.doesNotMatch(sql, /NOT IN/);
  assert.throws(() => compileMetric({ metric: 'persistence', filters: onDate() }, { excludedDates: ['15/10/2026'] }), /Invalid excluded date/);
});

test('persistence: eq only on the date, whitelisted dimensions, SQL without IS NOT DISTINCT FROM', () => {
  assert.throws(
    () => compileMetric({ metric: 'persistence', filters: [{ dimension: 'business_date', op: 'between', value: ['2026-10-13', '2026-10-15'] }] }),
    /only accepts: eq/,
  );
  assert.throws(() => compileMetric({ metric: 'persistence', filters: onDate(), dimensions: ['cp2_lei'] }), /Dimension not allowed/);
  const { sql } = compileMetric({
    metric: 'persistence',
    filters: [...onDate(), { dimension: 'asset_class', op: 'eq', value: 'CREDIT' }],
    dimensions: ['breaking_field'],
  });
  assert.doesNotMatch(sql, /DISTINCT FROM/);
  assert.match(sql, /FULL OUTER JOIN pre p/);
  assert.match(sql, /asset_class = 'CREDIT'/);
  assert.match(sql, /GROUP BY breaking_field/);
});

test('break key = production key (UTI and PROPRIETARY separate)', async () => {
  const { BREAK_KEY, dedupSelect } = await import('../src/db/model.js');
  assert.deepEqual(BREAK_KEY, [
    'business_date', 'report_submitting_entity', 'cp1_lei', 'cp2_lei', 'uti', 'proprietary', 'asset_class', 'breaking_field',
  ]);
  assert.match(dedupSelect(), /PARTITION BY business_date, report_submitting_entity, cp1_lei, cp2_lei, uti, proprietary, asset_class, breaking_field/);
});

test('config: legacy uti_alt in config/local.json is accepted as proprietary', async () => {
  const { loadConfig } = await import('../src/config.js');
  const c = loadConfig({ columns: { uti_alt: 'PROPRIETARY_X' } });
  assert.equal(c.columns.proprietary, 'PROPRIETARY_X');
  assert.equal(c.columns.uti_alt, undefined);
});

test('rule_verdict: reads break_verdict, filters only on the columns the table has', () => {
  const { sql } = compileMetric({
    metric: 'rule_verdict',
    filters: [...onDate(), { dimension: 'breaking_field', op: 'eq', value: 'VALUATION_CCY' }],
    dimensions: ['breaking_field', 'verdict'],
  });
  assert.match(sql, /FROM break_verdict/);
  assert.match(sql, /GROUP BY breaking_field, verdict/);
  assert.throws(
    () => compileMetric({ metric: 'rule_verdict', filters: [...onDate(), { dimension: 'business_line', op: 'eq', value: 'X' }] }),
    /Filter not allowed/,
  );
});
