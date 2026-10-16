import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileMetric, MetricUnavailableError } from '../src/semantic/compiler.js';
import { ValidationError } from '../src/semantic/literals.js';
import { describeCatalog } from '../src/semantic/catalog.js';

const onDate = (value = '2026-10-15') => [{ dimension: 'business_date', op: 'eq', value }];

test('catálogo tem as 6 métricas do plano, com reference_id_distribution pendente', () => {
  const cat = describeCatalog();
  assert.deepEqual(
    cat.metrics.map((m) => m.id).sort(),
    ['breaks_by_counterparty', 'breaks_by_field', 'breaks_dod', 'data_quality', 'reference_id_distribution', 'top_fields'],
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
