// Exploratory analysis queries (not certified metrics).
// They validate hypotheses of the plan: duplication, null keys, groups of correlated fields.
import { dateLiteral, intValue } from '../semantic/literals.js';
import { previousDateSql } from '../semantic/calendar.js';
import { positionKeyExpr, POSITION_KEY, tradeIdExpr } from '../db/model.js';

const POS = POSITION_KEY.join(', ');

/** Combinations of breaking fields per position (correlated groups hypothesis). */
export function fieldCombinationsSql(dialect, date, limit = 20) {
  const d = dateLiteral(date);
  const n = intValue(limit, { min: 1, max: 1000 });
  return `SELECT fields, COUNT(*) AS positions
FROM (
  SELECT ${POS}, ${dialect.stringAgg('breaking_field', ',', 'breaking_field')} AS fields
  FROM (
    SELECT ${POS}, breaking_field
    FROM breaks
    WHERE business_date = ${d}
    ORDER BY ${POS}, breaking_field
  ) s
  GROUP BY ${POS}
) p
GROUP BY fields
ORDER BY positions DESC, fields
LIMIT ${n}`;
}

/** Positions with the most raw rows — helps to diagnose the cause of duplication. */
export function topDuplicatedPositionsSql(date, limit = 10) {
  const d = dateLiteral(date);
  const n = intValue(limit, { min: 1, max: 1000 });
  return `SELECT ${POS},
  COUNT(*) AS raw_rows,
  COUNT(DISTINCT breaking_field) AS n_fields,
  COUNT(DISTINCT trade_number) AS n_trade_numbers
FROM breaks_raw
WHERE business_date = ${d}
GROUP BY ${POS}
ORDER BY raw_rows DESC, ${POS}
LIMIT ${n}`;
}

/**
 * Null keys and equal LEIs.
 * bnpp_null / cpty_null were removed on 2026-10-20: BNPP_REPORTED / CPTY_REPORTED are not the field values
 * (those are in the DTCC file), so "null" does not mean "side without a value" (CLAUDE.md §3.1.2).
 */
export function keyHealthSql(date) {
  const d = dateLiteral(date);
  return `SELECT
  COUNT(*) AS distinct_breaks,
  SUM(CASE WHEN uti IS NULL AND proprietary IS NULL THEN 1 ELSE 0 END) AS null_trade_id,
  SUM(CASE WHEN uti IS NOT NULL AND proprietary IS NOT NULL THEN 1 ELSE 0 END) AS both_uti_proprietary,
  SUM(CASE WHEN uti IS NULL AND proprietary IS NOT NULL THEN 1 ELSE 0 END) AS proprietary_only,
  SUM(CASE WHEN report_submitting_entity IS NULL OR report_submitting_entity = '' THEN 1 ELSE 0 END) AS null_submitting_entity,
  SUM(CASE WHEN cp1_lei IS NULL OR cp1_lei = '' THEN 1 ELSE 0 END) AS null_cp1_lei,
  SUM(CASE WHEN cp2_lei IS NULL OR cp2_lei = '' THEN 1 ELSE 0 END) AS null_cp2_lei,
  SUM(CASE WHEN cp1_lei = cp2_lei THEN 1 ELSE 0 END) AS same_lei
FROM breaks
WHERE business_date = ${d}`;
}

/**
 * Positions of D without a key match in D-1, but with the same LEI pair + trade number in D-1
 * under another identifier (e.g. PROPRIETARY -> UTI). Those trades inflate "new" and "resolved"
 * in the persistence metric. Aggregates only. Positions without a trade number are not part of the diagnosis.
 */
export function idChangeSql(date, excludedDates = []) {
  const d = dateLiteral(date);
  const tradeKey = (a) => `COALESCE(${a}.cp1_lei, '') || '|' || COALESCE(${a}.cp2_lei, '') || '|' || ${a}.trade_number`;
  return `WITH prev AS (
  ${previousDateSql(date, excludedDates)}
),
cur AS (
  SELECT DISTINCT ${POS}, trade_number FROM breaks WHERE business_date = ${d}
),
pre AS (
  SELECT DISTINCT ${POS}, trade_number FROM breaks WHERE business_date = (SELECT d FROM prev)
),
new_pos AS (
  SELECT c.* FROM cur c
  WHERE NOT EXISTS (SELECT 1 FROM pre p WHERE ${positionKeyExpr('p')} = ${positionKeyExpr('c')})
)
SELECT
  (SELECT d FROM prev) AS previous_date,
  (SELECT COUNT(DISTINCT ${positionKeyExpr()}) FROM new_pos) AS new_positions,
  (SELECT COUNT(DISTINCT ${positionKeyExpr('n')}) FROM new_pos n
    WHERE n.trade_number IS NOT NULL AND n.trade_number <> ''
      AND EXISTS (SELECT 1 FROM pre p WHERE ${tradeKey('p')} = ${tradeKey('n')} AND COALESCE(${tradeIdExpr('p')}, '') <> COALESCE(${tradeIdExpr('n')}, ''))
  ) AS id_changed_positions`;
}

/** Columns with real identifiers (UTI, PROPRIETARY, LEIs) that must not be shown by default. */
export const ID_COLUMNS = ['uti', 'proprietary', 'cp1_lei', 'cp2_lei', 'report_submitting_entity'];

/** Removes the identifiers from the rows (only the aggregates remain). */
export function redactIds(rows) {
  return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !ID_COLUMNS.includes(k))));
}

/** Runs the full profile of a business date. */
export async function profileDate(db, date, { combos = 20, dups = 10, excludedDates = [] } = {}) {
  const [keyHealth] = await db.all(keyHealthSql(date));
  const [idChange] = await db.all(idChangeSql(date, excludedDates));
  const duplicated = await db.all(topDuplicatedPositionsSql(date, dups));
  const combinations = await db.all(fieldCombinationsSql(db.dialect, date, combos));
  const positions = combinations.reduce((s, r) => s + Number(r.positions), 0);
  return { date, keyHealth, idChange, duplicated, combinations, combosCoverPositions: positions };
}
