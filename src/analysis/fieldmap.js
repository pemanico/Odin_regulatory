// Mapping BREAKING_FIELD (data mart) -> pair of columns TP1_<suffix> / TP2_<suffix> (DTCC file),
// and empirical validation: for the right suffix, breaks have TP1 ≠ TP2 and transactions without a break have TP1 = TP2.
// Only produces column names and counts (never values).
import { dateLiteral, stringLiteral } from '../semantic/literals.js';
import { POSITION_KEY } from '../db/model.js';

/** Normalised name for comparison: upper case, letters and digits only. */
export const normalizeName = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const tokens = (s) => String(s).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);

/**
 * TP1_/TP2_ pairs from the DTCC file column names.
 * @returns {{ suffix: string, tp1: string, tp2: string }[]}
 */
export function tpPairs(columnNames) {
  const tp2 = new Map(columnNames.filter((c) => /^TP2_/i.test(c)).map((c) => [c.slice(4).toUpperCase(), c]));
  return columnNames
    .filter((c) => /^TP1_/i.test(c) && tp2.has(c.slice(4).toUpperCase()))
    .map((c) => ({ suffix: c.slice(4), tp1: c, tp2: tp2.get(c.slice(4).toUpperCase()) }));
}

/** Similarity between names (0..1): shared tokens + a bonus if one normalised name contains the other. */
export function similarity(a, b) {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size || 1;
  const na = normalizeName(a);
  const nb = normalizeName(b);
  const contains = na && nb && (na.includes(nb) || nb.includes(na)) ? 0.5 : 0;
  return Math.min(1, inter / union + contains);
}

/**
 * Links each field to a TP pair. Order: explicit override > same (normalised) name > no mapping
 * (with up to 3 candidates by similarity, for a human decision — never picked automatically).
 * @param fields  BREAKING_FIELD names
 * @param pairs   result of tpPairs()
 * @param overrides  { FIELD: 'SUFFIX' }
 */
export function matchFields(fields, pairs, overrides = {}) {
  const bySuffix = new Map(pairs.map((p) => [normalizeName(p.suffix), p]));
  const ov = new Map(Object.entries(overrides).map(([k, v]) => [normalizeName(k), normalizeName(v)]));
  return fields.map((field) => {
    const n = normalizeName(field);
    if (ov.has(n)) {
      const pair = bySuffix.get(ov.get(n));
      if (!pair) throw new Error(`Invalid override: ${field} -> ${overrides[field] ?? ov.get(n)} (suffix does not exist in the DTCC file)`);
      return { field, pair, how: 'override', candidates: [] };
    }
    if (bySuffix.has(n)) return { field, pair: bySuffix.get(n), how: 'same name', candidates: [] };
    const candidates = pairs
      .map((p) => ({ suffix: p.suffix, score: similarity(field, p.suffix) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score || a.suffix.localeCompare(b.suffix))
      .slice(0, 3)
      .map((c) => c.suffix);
    return { field, pair: null, how: null, candidates };
  });
}

const quoteIdent = (name) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid column name: ${name}`);
  return `"${name}"`;
};

/**
 * SELECT from the DTCC file for ONE business date, with only the key (logical names, normalised as in the data mart)
 * and the requested TP pairs (tp1_0, tp2_0, tp1_1, ...). The physical key columns are the same as in the data mart.
 */
export function dtccSelectSql(config, dialect, fromSql, date, pairs, extraCols = []) {
  const d = dateLiteral(date);
  const cols = config.columns;
  const key = POSITION_KEY.map((logical) => {
    const physical = cols[logical];
    if (!physical) throw new Error(`Missing mapping for column "${logical}" (needed to join the DTCC file)`);
    return `NULLIF(TRIM(${dialect.castText(quoteIdent(physical))}), '') AS ${logical}`;
  });
  const tps = pairs.flatMap((p, i) => [
    `${dialect.castText(quoteIdent(p.tp1))} AS tp1_${i}`,
    `${dialect.castText(quoteIdent(p.tp2))} AS tp2_${i}`,
  ]);
  // Report status columns (e.g. VALUATION_RECONCILIATION) to explain differences without a break: st_0, st_1...
  const extra = extraCols.map((c, i) => `${dialect.castText(quoteIdent(c))} AS st_${i}`);
  const dateCol = dialect.castDate(quoteIdent(cols.business_date), null);
  return `SELECT\n  ${[...key, ...tps, ...extra].join(',\n  ')}\nFROM ${fromSql}\nWHERE ${dateCol} = ${d}`;
}

/**
 * Confusion matrix of a field: data mart breaks (business date + field) vs. TP1 ≠ TP2 in the DTCC file.
 * `dtccTable` has the logical key + tp1_<i>/tp2_<i> (see dtccSelectSql). Standard SQL.
 * Different = different values, or only one of the sides NULL.
 */
export function confusionSql(date, field, i, dtccTable = 'dtcc') {
  const d = dateLiteral(date);
  const f = stringLiteral(String(field).toUpperCase());
  const keyCols = POSITION_KEY.join(', ');
  const on = POSITION_KEY.map((k) => `COALESCE(t.${k}, '') = COALESCE(b.${k}, '')`).join('\n    AND ');
  const a = `t.tp1_${i}`;
  const c = `t.tp2_${i}`;
  return `WITH b AS (
  SELECT DISTINCT ${keyCols}, 1 AS present
  FROM breaks
  WHERE business_date = ${d} AND UPPER(breaking_field) = ${f}
),
j AS (
  SELECT
    b.present,
    CASE WHEN (${a} = ${c}) OR (${a} IS NULL AND ${c} IS NULL) THEN 0 ELSE 1 END AS is_diff
  FROM ${dtccTable} t
  LEFT JOIN b
    ON ${on}
)
SELECT
  (SELECT COUNT(*) FROM b) AS n_breaks,
  SUM(CASE WHEN present = 1 THEN 1 ELSE 0 END) AS breaks_found,
  SUM(CASE WHEN present = 1 AND is_diff = 1 THEN 1 ELSE 0 END) AS break_diff,
  SUM(CASE WHEN present = 1 AND is_diff = 0 THEN 1 ELSE 0 END) AS break_equal,
  SUM(CASE WHEN present IS NULL AND is_diff = 1 THEN 1 ELSE 0 END) AS nobreak_diff,
  SUM(CASE WHEN present IS NULL AND is_diff = 0 THEN 1 ELSE 0 END) AS nobreak_equal
FROM j`;
}

/**
 * For one field, counts break / no break × TP1 ≠ TP2 by the values of the status columns st_0..st_{n-1}.
 * Explains why there is TP1 ≠ TP2 without a break (e.g. valuation not reconciled in that transaction).
 * The status columns are report status codes (not identifiers).
 */
export function explainSql(date, field, i, nStatus, dtccTable = 'dtcc') {
  const base = confusionSql(date, field, i, dtccTable);
  const st = Array.from({ length: nStatus }, (_, k) => `st_${k}`);
  const withStatus = base
    .replace('    b.present,', `    b.present,\n    ${st.map((s) => `t.${s}`).join(', ')},`)
    .replace(/\nSELECT\n  \(SELECT COUNT\(\*\) FROM b\) AS n_breaks,\n/, `\nSELECT\n  ${st.join(', ')},\n`);
  return `${withStatus}\nGROUP BY ${st.join(', ')}\nORDER BY nobreak_diff DESC, break_diff DESC, ${st.join(', ')}`;
}

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

/** Adds percentages to the confusion matrix row. */
export function confusionRow(r) {
  const n = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v ?? 0)]));
  return {
    ...n,
    pct_found: pct(n.breaks_found, n.n_breaks),
    pct_break_diff: pct(n.break_diff, n.breaks_found),
    pct_nobreak_diff: pct(n.nobreak_diff, n.nobreak_diff + n.nobreak_equal),
  };
}

/**
 * Classifies the result of a TP pair (confusionRow row) for the full validation.
 *  - ok: all breaks found, all with TP1 ≠ TP2, and no difference without a break
 *  - no differences: no break and no difference (field always equal on both sides)
 *  - differences without break: TP1 ≠ TP2 in transactions without a break (field not reconciled, tolerance, or
 *    BREAKING_FIELD name different from the suffix)
 *  - breaks with equal values / breaks not found: wrong mapping or key
 */
export function classify(r) {
  const issues = [];
  if (r.breaks_found < r.n_breaks) issues.push('breaks not found');
  if (r.break_equal > 0) issues.push('breaks with equal values');
  if (r.nobreak_diff > 0) issues.push('differences without break');
  if (issues.length) return issues.join(' + ');
  return r.n_breaks > 0 ? 'ok' : 'no differences';
}
