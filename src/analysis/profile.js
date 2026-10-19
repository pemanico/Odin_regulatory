// Queries de análise exploratória (não são métricas certificadas).
// Servem para validar hipóteses do plano: duplicação, chaves nulas, grupos de campos correlacionados.
import { dateLiteral, intValue } from '../semantic/literals.js';

/** Combinações de campos em break por position (hipótese dos grupos correlacionados). */
export function fieldCombinationsSql(dialect, date, limit = 20) {
  const d = dateLiteral(date);
  const n = intValue(limit, { min: 1, max: 1000 });
  return `SELECT fields, COUNT(*) AS positions
FROM (
  SELECT uti, cp1_lei, cp2_lei, ${dialect.stringAgg('breaking_field', ',', 'breaking_field')} AS fields
  FROM (
    SELECT uti, cp1_lei, cp2_lei, breaking_field
    FROM breaks
    WHERE business_date = ${d}
    ORDER BY uti, cp1_lei, cp2_lei, breaking_field
  ) s
  GROUP BY uti, cp1_lei, cp2_lei
) p
GROUP BY fields
ORDER BY positions DESC, fields
LIMIT ${n}`;
}

/** Positions com mais linhas brutas — ajuda a diagnosticar a causa da duplicação. */
export function topDuplicatedPositionsSql(date, limit = 10) {
  const d = dateLiteral(date);
  const n = intValue(limit, { min: 1, max: 1000 });
  return `SELECT uti, cp1_lei, cp2_lei,
  COUNT(*) AS raw_rows,
  COUNT(DISTINCT breaking_field) AS n_fields,
  COUNT(DISTINCT trade_number) AS n_trade_numbers
FROM breaks_raw
WHERE business_date = ${d}
GROUP BY uti, cp1_lei, cp2_lei
ORDER BY raw_rows DESC, uti
LIMIT ${n}`;
}

/** Chaves nulas e LEIs iguais. */
export function keyHealthSql(date) {
  const d = dateLiteral(date);
  return `SELECT
  COUNT(*) AS distinct_breaks,
  SUM(CASE WHEN uti IS NULL OR uti = '' THEN 1 ELSE 0 END) AS null_uti,
  SUM(CASE WHEN cp1_lei IS NULL OR cp1_lei = '' THEN 1 ELSE 0 END) AS null_cp1_lei,
  SUM(CASE WHEN cp2_lei IS NULL OR cp2_lei = '' THEN 1 ELSE 0 END) AS null_cp2_lei,
  SUM(CASE WHEN cp1_lei = cp2_lei THEN 1 ELSE 0 END) AS same_lei,
  SUM(CASE WHEN bnpp_value IS NULL THEN 1 ELSE 0 END) AS bnpp_null,
  SUM(CASE WHEN cpty_value IS NULL THEN 1 ELSE 0 END) AS cpty_null
FROM breaks
WHERE business_date = ${d}`;
}

/** Colunas com identificadores reais (UTI, LEIs) que não devem sair no ecrã por omissão. */
export const ID_COLUMNS = ['uti', 'cp1_lei', 'cp2_lei'];

/** Remove os identificadores das linhas (só ficam os agregados). */
export function redactIds(rows) {
  return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !ID_COLUMNS.includes(k))));
}

/** Corre o perfil completo de uma business date. */
export async function profileDate(db, date, { combos = 20, dups = 10 } = {}) {
  const [keyHealth] = await db.all(keyHealthSql(date));
  const duplicated = await db.all(topDuplicatedPositionsSql(date, dups));
  const combinations = await db.all(fieldCombinationsSql(db.dialect, date, combos));
  const positions = combinations.reduce((s, r) => s + Number(r.positions), 0);
  return { date, keyHealth, duplicated, combinations, combosCoverPositions: positions };
}
