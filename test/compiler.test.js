import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileMetric, MetricUnavailableError } from '../src/semantic/compiler.js';
import { ValidationError } from '../src/semantic/literals.js';
import { describeCatalog } from '../src/semantic/catalog.js';

const onDate = (value = '2026-10-15') => [{ dimension: 'business_date', op: 'eq', value }];

test('catálogo tem as 6 métricas do plano + persistence, com reference_id_distribution pendente', () => {
  const cat = describeCatalog();
  assert.deepEqual(
    cat.metrics.map((m) => m.id).sort(),
    ['breaks_by_counterparty', 'breaks_by_field', 'breaks_dod', 'data_quality', 'persistence', 'reference_id_distribution', 'rule_verdict', 'top_fields'],
  );
  assert.equal(cat.metrics.find((m) => m.id === 'reference_id_distribution').available, false);
});

test('métrica desconhecida e métrica pendente são rejeitadas', () => {
  assert.throws(() => compileMetric({ metric: 'drop_table', filters: onDate() }), ValidationError);
  assert.throws(() => compileMetric({ metric: 'reference_id_distribution' }), MetricUnavailableError);
});

test('top_fields compila com limite por omissão 10 e grão deduplicado', () => {
  const { sql } = compileMetric({ metric: 'top_fields', filters: onDate() });
  assert.match(sql, /FROM breaks\n/);
  assert.match(sql, /business_date = '2026-10-15'/);
  assert.match(sql, /LIMIT 10$/);
});

test('filtro obrigatório em falta', () => {
  assert.throws(() => compileMetric({ metric: 'top_fields' }), /obrigatório/);
});

test('valores de filtro são escapados (sem injeção)', () => {
  const { sql } = compileMetric({
    metric: 'breaks_by_field',
    filters: [...onDate(), { dimension: 'cp2_lei', op: 'eq', value: "X' OR 1=1 --" }],
  });
  assert.match(sql, /cp2_lei = 'X'' OR 1=1 --'/);
});

test('dimensões e filtros fora da whitelist são rejeitados', () => {
  assert.throws(
    () => compileMetric({ metric: 'top_fields', filters: onDate(), dimensions: ['cp2_lei'] }),
    /Dimensão não permitida/,
  );
  assert.throws(
    () => compileMetric({ metric: 'breaks_by_field', filters: [...onDate(), { dimension: 'bnpp_value', op: 'eq', value: 'x' }] }),
    /Filtro não permitido/,
  );
  assert.throws(
    () => compileMetric({ metric: 'breaks_by_field', filters: onDate(), dimensions: ['breaking_field; DROP TABLE breaks'] }),
    /Dimensão não permitida/,
  );
});

test('datas inválidas, intervalos invertidos e limites fora do intervalo', () => {
  assert.throws(() => compileMetric({ metric: 'top_fields', filters: onDate('2026-02-30') }), /Data inválida/);
  assert.throws(
    () => compileMetric({ metric: 'top_fields', filters: [{ dimension: 'business_date', op: 'between', value: ['2026-10-15', '2026-10-12'] }] }),
    /invertido/,
  );
  assert.throws(() => compileMetric({ metric: 'top_fields', filters: onDate(), limit: 0 }), /Inteiro inválido/);
  assert.throws(() => compileMetric({ metric: 'top_fields', filters: onDate(), limit: 'all' }), /Inteiro inválido/);
});

test('breaks_dod exige business_date com eq', () => {
  assert.throws(
    () => compileMetric({ metric: 'breaks_dod', filters: [{ dimension: 'business_date', op: 'between', value: ['2026-10-12', '2026-10-15'] }] }),
    /só aceita: eq/,
  );
  const { sql } = compileMetric({ metric: 'breaks_dod', filters: onDate() });
  assert.match(sql, /business_date < '2026-10-15'/);
});

test('filtro "in" valida a lista', () => {
  assert.throws(
    () => compileMetric({ metric: 'breaks_by_field', filters: [...onDate(), { dimension: 'breaking_field', op: 'in', value: [] }] }),
    /lista/,
  );
  const { sql } = compileMetric({
    metric: 'breaks_by_field',
    filters: [...onDate(), { dimension: 'breaking_field', op: 'in', value: ['ISIN', 'VALUATION_AMT'] }],
  });
  assert.match(sql, /breaking_field IN \('ISIN', 'VALUATION_AMT'\)/);
});

test('profile: redactIds remove UTI e LEIs e mantém os agregados', async () => {
  const { redactIds } = await import('../src/analysis/profile.js');
  const [row] = redactIds([{ uti: 'X', cp1_lei: 'A', cp2_lei: 'B', raw_rows: 3, n_fields: 2, n_trade_numbers: 1 }]);
  assert.deepEqual(row, { raw_rows: 3, n_fields: 2, n_trade_numbers: 1 });
});

test('datas excluídas: saltadas no dia anterior e rejeitadas como data pedida', () => {
  const excludedDates = ['2026-10-12'];
  for (const metric of ['breaks_dod', 'persistence']) {
    const { sql } = compileMetric({ metric, filters: onDate('2026-10-13') }, { excludedDates });
    assert.match(sql, /business_date < '2026-10-13' AND business_date NOT IN \('2026-10-12'\)/);
    assert.throws(() => compileMetric({ metric, filters: onDate('2026-10-12') }, { excludedDates }), /excluída/);
  }
  // Sem datas excluídas, o comportamento antigo mantém-se.
  const { sql } = compileMetric({ metric: 'breaks_dod', filters: onDate('2026-10-13') });
  assert.doesNotMatch(sql, /NOT IN/);
  assert.throws(() => compileMetric({ metric: 'persistence', filters: onDate() }, { excludedDates: ['15/10/2026'] }), /inválida/);
});

test('persistence: só eq na data, dimensões na whitelist, SQL sem IS NOT DISTINCT FROM', () => {
  assert.throws(
    () => compileMetric({ metric: 'persistence', filters: [{ dimension: 'business_date', op: 'between', value: ['2026-10-13', '2026-10-15'] }] }),
    /só aceita: eq/,
  );
  assert.throws(() => compileMetric({ metric: 'persistence', filters: onDate(), dimensions: ['cp2_lei'] }), /Dimensão não permitida/);
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

test('chave do break = chave de produção (UTI e PROPRIETARY separados)', async () => {
  const { BREAK_KEY, dedupSelect } = await import('../src/db/model.js');
  assert.deepEqual(BREAK_KEY, [
    'business_date', 'report_submitting_entity', 'cp1_lei', 'cp2_lei', 'uti', 'proprietary', 'asset_class', 'breaking_field',
  ]);
  assert.match(dedupSelect(), /PARTITION BY business_date, report_submitting_entity, cp1_lei, cp2_lei, uti, proprietary, asset_class, breaking_field/);
});

test('config: uti_alt antigo em config/local.json é aceite como proprietary', async () => {
  const { loadConfig } = await import('../src/config.js');
  const c = loadConfig({ columns: { uti_alt: 'PROPRIETARY_X' } });
  assert.equal(c.columns.proprietary, 'PROPRIETARY_X');
  assert.equal(c.columns.uti_alt, undefined);
});

test('rule_verdict: lê break_verdict, filtros só nas colunas que a tabela tem', () => {
  const { sql } = compileMetric({
    metric: 'rule_verdict',
    filters: [...onDate(), { dimension: 'breaking_field', op: 'eq', value: 'VALUATION_CCY' }],
    dimensions: ['breaking_field', 'verdict'],
  });
  assert.match(sql, /FROM break_verdict/);
  assert.match(sql, /GROUP BY breaking_field, verdict/);
  assert.throws(
    () => compileMetric({ metric: 'rule_verdict', filters: [...onDate(), { dimension: 'business_line', op: 'eq', value: 'X' }] }),
    /Filtro não permitido/,
  );
});
