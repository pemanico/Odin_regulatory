// Calendário de business dates para as métricas que comparam um dia com o anterior.
// "Dia anterior" = business date anterior DISPONÍVEL nos dados, saltando as datas excluídas
// (ex.: 2026-10-12, dia anómalo com o lado da contraparte em falta — ver CLAUDE.md §4.1).
import { ValidationError, dateLiteral, isValidDate } from './literals.js';

/** Normaliza e valida a lista de datas excluídas (YYYY-MM-DD). */
export function normalizeExcludedDates(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new ValidationError('excludedDates tem de ser uma lista de datas YYYY-MM-DD');
  for (const d of list) {
    if (!isValidDate(d)) throw new ValidationError(`Data excluída inválida (esperado YYYY-MM-DD): ${JSON.stringify(d)}`);
  }
  return [...new Set(list)].sort();
}

/** Rejeita comparações cuja data pedida está excluída. */
export function assertNotExcluded(date, excludedDates) {
  if (normalizeExcludedDates(excludedDates).includes(date)) {
    throw new ValidationError(
      `A business date ${date} está excluída das comparações entre dias (config excludedDates). Escolha outra data.`,
    );
  }
}

/**
 * Subquery escalar com a business date anterior disponível (NULL se não houver).
 * SQL standard: igual em DuckDB, ClickHouse e SQLite.
 */
export function previousDateSql(date, excludedDates, table = 'breaks') {
  const d = dateLiteral(date);
  const excluded = normalizeExcludedDates(excludedDates);
  const notIn = excluded.length ? ` AND business_date NOT IN (${excluded.map(dateLiteral).join(', ')})` : '';
  return `SELECT MAX(business_date) AS d FROM ${table} WHERE business_date < ${d}${notIn}`;
}
