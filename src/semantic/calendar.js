// Business date calendar for the metrics that compare a day with the previous one.
// "Previous day" = previous business date AVAILABLE in the data, skipping the excluded dates
// (e.g. 2026-10-12, an anomalous day with the counterparty side missing — see CLAUDE.md §4.1).
import { ValidationError, dateLiteral, isValidDate } from './literals.js';

/** Normalises and validates the list of excluded dates (YYYY-MM-DD). */
export function normalizeExcludedDates(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new ValidationError('excludedDates must be a list of YYYY-MM-DD dates');
  for (const d of list) {
    if (!isValidDate(d)) throw new ValidationError(`Invalid excluded date (expected YYYY-MM-DD): ${JSON.stringify(d)}`);
  }
  return [...new Set(list)].sort();
}

/** Rejects comparisons whose requested date is excluded. */
export function assertNotExcluded(date, excludedDates) {
  if (normalizeExcludedDates(excludedDates).includes(date)) {
    throw new ValidationError(
      `Business date ${date} is excluded from day-on-day comparisons (config excludedDates). Choose another date.`,
    );
  }
}

/**
 * Scalar subquery with the previous available business date (NULL if there is none).
 * Standard SQL: the same in DuckDB, ClickHouse and SQLite.
 */
export function previousDateSql(date, excludedDates, table = 'breaks') {
  const d = dateLiteral(date);
  const excluded = normalizeExcludedDates(excludedDates);
  const notIn = excluded.length ? ` AND business_date NOT IN (${excluded.map(dateLiteral).join(', ')})` : '';
  return `SELECT MAX(business_date) AS d FROM ${table} WHERE business_date < ${d}${notIn}`;
}
