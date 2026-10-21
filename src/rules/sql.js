// Rules engine SQL: input (DTCC transactions with a break), results per rule and verdict per break.
// Standard SQL only + dialect functions (regexFull, castNumber, stringAgg).
import { dateLiteral } from '../semantic/literals.js';
import { POSITION_KEY } from '../db/model.js';

const quoteIdent = (name) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid column name: ${name}`);
  return `"${name}"`;
};
const sqlString = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** Key columns in the input table: k_<logical> (avoids clashes with the physical names, e.g. UTI). */
export const K = POSITION_KEY.map((k) => `k_${k}`);

/** Normalised key from the physical columns (the same in the data mart and in the DTCC file). */
export function keySelect(config, dialect) {
  return POSITION_KEY.map(
    (logical) => `NULLIF(TRIM(${dialect.castText(quoteIdent(config.columns[logical]))}), '') AS k_${logical}`,
  ).join(',\n  ');
}

/**
 * DTCC file transactions of a business date that have a break in the data mart, with the normalised key
 * and only the columns the rules use (`columns`; empty = all).
 * Scope (Ordep, 2026-10-20): the rules only run on the data mart breaks. Validating the whole DTCC file
 * is "data quality", a future requirement.
 */
export function ruleInputSql(config, dialect, fromSql, date, { columns = [] } = {}) {
  const d = dateLiteral(date);
  const dateCol = dialect.castDate(quoteIdent(config.columns.business_date), null);
  const cols = columns.length ? columns.map((c) => `s.${quoteIdent(c)}`).join(', ') : 's.*';
  const base = `SELECT\n  ${keySelect(config, dialect)},\n  ${cols}\nFROM ${fromSql} s\nWHERE ${dateCol} = ${d}`;
  const on = POSITION_KEY.map((k) => `COALESCE(t.k_${k}, '') = COALESCE(p.${k}, '')`).join('\n  AND ');
  return `SELECT t.*
FROM (
${base}
) t
JOIN (SELECT DISTINCT ${POSITION_KEY.join(', ')} FROM breaks WHERE business_date = ${d}) p
  ON ${on}`;
}

export const RESULTS_DDL = `CREATE TABLE IF NOT EXISTS rule_results (
  business_date DATE,
  ${POSITION_KEY.map((k) => `${k} VARCHAR`).join(',\n  ')},
  item VARCHAR,
  target VARCHAR,
  side VARCHAR,
  code VARCHAR,
  rules_version VARCHAR
)`;

/**
 * INSERT of the violations of one rule on one side, only for the transactions where the rule's field is in break
 * (the VALUATION_CCY rule only runs on VALUATION_CCY breaks). `violates` = expression from compileRule.
 */
export function insertViolationsSql(date, c, side, violates, version, input = 'rule_input') {
  const d = dateLiteral(date);
  const target = String(c.suffix ?? '').toUpperCase();
  const on = POSITION_KEY.map((k) => `COALESCE(b.${k}, '') = COALESCE(i.k_${k}, '')`).join('\n    AND ');
  return `INSERT INTO rule_results
SELECT ${d}, ${K.map((k) => `i.${k}`).join(', ')}, ${sqlString(c.rule.item)}, ${sqlString(target)},
  ${sqlString(side)}, ${sqlString(c.rule.code)}, ${sqlString(version)}
FROM ${input} i
WHERE ${violates}
  AND EXISTS (
    SELECT 1 FROM breaks b
    WHERE b.business_date = ${d} AND UPPER(b.breaking_field) = ${sqlString(target)}
    AND ${on}
  )`;
}

/** Violations per rule and side on a business date (for the rate per rule). */
export function violationCountsSql(date) {
  return `SELECT code, side, COUNT(*) AS n FROM rule_results WHERE business_date = ${dateLiteral(date)} GROUP BY code, side`;
}

/** Breaks per field (upper case) on a business date. */
export function breaksByFieldSql(date) {
  return `SELECT UPPER(breaking_field) AS target, COUNT(*) AS n FROM breaks WHERE business_date = ${dateLiteral(date)} GROUP BY UPPER(breaking_field)`;
}

/**
 * Rule suspected of a wrong translation: violates on BOTH sides in more than `pct`% of the breaks of its field.
 * A real error is usually on one side; a wrong translation fails on both (the format is the same on both sides).
 */
export function isSuspect(pctBnpp, pctCpty, pct = 5) {
  return pctBnpp != null && pctCpty != null && pctBnpp > pct && pctCpty > pct;
}

export const VERDICT_DDL = `CREATE TABLE IF NOT EXISTS break_verdict (
  business_date DATE,
  ${POSITION_KEY.map((k) => `${k} VARCHAR`).join(',\n  ')},
  breaking_field VARCHAR,
  verifiable_rules INTEGER,
  bnpp_violations INTEGER,
  cpty_violations INTEGER,
  bnpp_codes VARCHAR,
  cpty_codes VARCHAR,
  verdict VARCHAR,
  rules_version VARCHAR
)`;

/** Possible verdicts per break (in UI reading order). */
export const VERDICTS = ['bnpp_only', 'cpty_only', 'both', 'divergence', 'no_verifiable_rules'];
export const DIVERGENCE_MESSAGE =
  'Divergence: both values comply with the verifiable ESMA rules; the rules do not determine which side is wrong.';

/**
 * Verdict per break on the business date. `field_rules` = table (target, n) with the number of verifiable rules per field.
 * A break whose field has no verifiable rules is "no_verifiable_rules" (not a divergence).
 */
export function insertVerdictSql(date, dialect, version) {
  const d = dateLiteral(date);
  const on = POSITION_KEY.map((k) => `COALESCE(r.${k}, '') = COALESCE(b.${k}, '')`).join('\n    AND ');
  const codes = (side) =>
    dialect.stringAgg(`CASE WHEN r.side = '${side}' THEN r.code END`, ',', `CASE WHEN r.side = '${side}' THEN r.code END`);
  return `INSERT INTO break_verdict
SELECT
  ${d},
  ${POSITION_KEY.map((k) => `b.${k}`).join(', ')},
  b.field,
  COALESCE(MAX(f.n), 0),
  SUM(CASE WHEN r.side = 'BNPP' THEN 1 ELSE 0 END),
  SUM(CASE WHEN r.side = 'CPTY' THEN 1 ELSE 0 END),
  ${codes('BNPP')},
  ${codes('CPTY')},
  CASE
    WHEN COALESCE(MAX(f.n), 0) = 0 THEN 'no_verifiable_rules'
    WHEN SUM(CASE WHEN r.side = 'BNPP' THEN 1 ELSE 0 END) > 0 AND SUM(CASE WHEN r.side = 'CPTY' THEN 1 ELSE 0 END) > 0 THEN 'both'
    WHEN SUM(CASE WHEN r.side = 'BNPP' THEN 1 ELSE 0 END) > 0 THEN 'bnpp_only'
    WHEN SUM(CASE WHEN r.side = 'CPTY' THEN 1 ELSE 0 END) > 0 THEN 'cpty_only'
    ELSE 'divergence'
  END,
  ${sqlString(version)}
FROM (SELECT ${POSITION_KEY.join(', ')}, UPPER(breaking_field) AS field FROM breaks WHERE business_date = ${d}) b
LEFT JOIN field_rules f ON f.target = b.field
LEFT JOIN rule_results r
  ON r.business_date = ${d}
    AND r.target = b.field
    AND ${on}
GROUP BY ${POSITION_KEY.map((k) => `b.${k}`).join(', ')}, b.field`;
}

/** field_rules table (target, n) from the compiled rules (n = rules with SQL on at least one side). */
export function fieldRulesSql(compiled) {
  const counts = new Map();
  for (const c of compiled) {
    if (!c.suffix) continue;
    const t = c.suffix.toUpperCase();
    const ok = Object.values(c.sides).some((s) => s.sql);
    counts.set(t, (counts.get(t) ?? 0) + (ok ? 1 : 0));
  }
  const rows = [...counts.entries()].map(([t, n]) => `SELECT ${sqlString(t)} AS target, ${n} AS n`);
  const body = rows.length ? rows.join('\nUNION ALL ') : `SELECT CAST(NULL AS VARCHAR) AS target, 0 AS n WHERE 1 = 0`;
  return `CREATE TEMP TABLE field_rules AS ${body}`;
}

/** Physical columns used in the compiled expressions (quoted identifiers). */
export function usedColumns(compiled) {
  const out = new Set();
  for (const c of compiled) {
    for (const s of Object.values(c.sides)) {
      for (const m of String(s.sql ?? '').matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)) out.add(m[1]);
    }
  }
  return [...out].sort();
}

/** Supporting temp tables: rule_catalog (code -> error message) and field_names (suffix -> ESMA field label). */
export function catalogTablesSql(compiled, fieldMap, describeRule, fieldLabel) {
  const rows = compiled.map((c) => `SELECT ${sqlString(c.rule.code)} AS code, ${sqlString(describeRule(c.rule, fieldMap))} AS message`);
  const names = new Map();
  for (const e of Object.values(fieldMap.items)) for (const t of e.tp ?? []) names.set(t.toUpperCase(), fieldLabel(t, fieldMap));
  const nrows = [...names.entries()].map(([t, l]) => `SELECT ${sqlString(t)} AS target, ${sqlString(l)} AS field_label`);
  return [
    'DROP TABLE IF EXISTS rule_catalog',
    `CREATE TEMP TABLE rule_catalog AS ${rows.length ? rows.join('\nUNION ALL ') : "SELECT '' AS code, '' AS message WHERE 1 = 0"}`,
    'DROP TABLE IF EXISTS field_names',
    `CREATE TEMP TABLE field_names AS ${nrows.length ? nrows.join('\nUNION ALL ') : "SELECT '' AS target, '' AS field_label WHERE 1 = 0"}`,
  ];
}

export const DETAIL_DDL = `CREATE TABLE IF NOT EXISTS break_detail (
  business_date DATE,
  ${POSITION_KEY.map((k) => `${k} VARCHAR`).join(',\n  ')},
  field_label VARCHAR,
  breaking_field VARCHAR,
  bnpp_value VARCHAR,
  other_cpty_value VARCHAR,
  verdict_text VARCHAR,
  bnpp_error VARCHAR,
  other_cpty_error VARCHAR,
  rules_version VARCHAR
)`;

/** Verdict text for the operations user (errors come from the rules; divergence and no rules have a fixed message). */
export const VERDICT_TEXT = {
  bnpp_only: 'Error on the BNPP side',
  cpty_only: 'Error on the counterparty side',
  both: 'Error on both sides',
  divergence: DIVERGENCE_MESSAGE,
  no_verifiable_rules: 'No ESMA rules can be verified for this field with the DTCC file data.',
};

/**
 * Detail per break for the operations users: key, ESMA field, TP1 (BNPP) / TP2 (other cpty) values of the field in break,
 * verdict and the messages of the rules violated on each side. `valueFields` = suffixes with TP1_/TP2_ columns in rule_input.
 */
export function insertDetailSql(date, dialect, valueFields, version, input = 'rule_input') {
  const d = dateLiteral(date);
  const val = (prefix) => (valueFields.length
    ? `CASE bv.breaking_field\n${valueFields.map((f) => `    WHEN ${sqlString(f)} THEN ${dialect.castText(quoteIdent(`${prefix}_${f}`))}`).join('\n')}\n  END`
    : 'NULL');
  const onInput = POSITION_KEY.map((k) => `COALESCE(i.k_${k}, '') = COALESCE(bv.${k}, '')`).join(' AND ');
  const onMsg = (a) => POSITION_KEY.map((k) => `COALESCE(${a}.${k}, '') = COALESCE(bv.${k}, '')`).join(' AND ');
  const verdictText = `CASE bv.verdict ${Object.entries(VERDICT_TEXT).map(([k, t]) => `WHEN ${sqlString(k)} THEN ${sqlString(t)}`).join(' ')} END`;
  return `INSERT INTO break_detail
WITH m AS (
  SELECT ${POSITION_KEY.map((k) => `r.${k}`).join(', ')}, r.target, r.side,
         ${dialect.stringAgg('c.message', ' | ', 'c.message')} AS msg
  FROM rule_results r JOIN rule_catalog c ON c.code = r.code
  WHERE r.business_date = ${d}
  GROUP BY ${POSITION_KEY.map((k) => `r.${k}`).join(', ')}, r.target, r.side
)
SELECT ${d}, ${POSITION_KEY.map((k) => `bv.${k}`).join(', ')},
  COALESCE(fn.field_label, bv.breaking_field), bv.breaking_field,
  ${val('TP1')},
  ${val('TP2')},
  ${verdictText},
  mb.msg, mc.msg, ${sqlString(version)}
FROM break_verdict bv
LEFT JOIN ${input} i ON ${onInput}
LEFT JOIN field_names fn ON fn.target = bv.breaking_field
LEFT JOIN m mb ON mb.side = 'BNPP' AND mb.target = bv.breaking_field AND ${onMsg('mb')}
LEFT JOIN m mc ON mc.side = 'CPTY' AND mc.target = bv.breaking_field AND ${onMsg('mc')}
WHERE bv.business_date = ${d}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Summary per Key (transaction) — demo screen 3 (plan approved on 2026-10-20).
// Key = production key WITHOUT the field (POSITION_KEY). One row per Key and business date, with the number of fields
// in break, the field combination, the counts per verdict and the Key verdict. Precomputed by `npm run rules`
// so that the server only reads (DuckDB READ_ONLY).

/** Verdict of a Key (filter and sort). A "both" field counts as an error on both sides → "mixed". */
export const KEY_VERDICTS = ['bnpp', 'counterparty', 'mixed', 'unexplained'];

export const KEY_SUMMARY_DDL = `CREATE TABLE IF NOT EXISTS key_summary (
  business_date DATE,
  key_id INTEGER,
  ${POSITION_KEY.map((k) => `${k} VARCHAR`).join(',\n  ')},
  n_fields INTEGER,
  combo VARCHAR,
  n_bnpp_only INTEGER,
  n_cpty_only INTEGER,
  n_both INTEGER,
  n_divergence INTEGER,
  n_no_rules INTEGER,
  key_verdict VARCHAR,
  rules_version VARCHAR
)`;

/**
 * INSERT of the per-Key summary from break_verdict. `combo` = sorted fields in break, formatted as `|A|B|C|`
 * (the delimiters at both ends allow filtering "combinations containing field X" with LIKE '%|X|%').
 * `key_id` = sequence number per date (most fields first): identifies the Key in the URL without exposing UTI/LEIs.
 */
export function insertKeySummarySql(date, dialect, version) {
  const d = dateLiteral(date);
  const keys = POSITION_KEY.join(', ');
  const n = (v) => `SUM(CASE WHEN verdict = '${v}' THEN 1 ELSE 0 END)`;
  const order = POSITION_KEY.map((k) => `COALESCE(${k}, '')`).join(', ');
  return `INSERT INTO key_summary
SELECT ${d},
  ROW_NUMBER() OVER (ORDER BY n_fields DESC, ${order}),
  ${keys}, n_fields, combo, n_bnpp_only, n_cpty_only, n_both, n_divergence, n_no_rules,
  CASE
    WHEN n_bnpp_only + n_both > 0 AND n_cpty_only + n_both > 0 THEN 'mixed'
    WHEN n_bnpp_only > 0 THEN 'bnpp'
    WHEN n_cpty_only > 0 THEN 'counterparty'
    ELSE 'unexplained'
  END,
  ${sqlString(version)}
FROM (
  SELECT ${keys},
    COUNT(*) AS n_fields,
    '|' || ${dialect.stringAgg('breaking_field', '|', 'breaking_field')} || '|' AS combo,
    ${n('bnpp_only')} AS n_bnpp_only,
    ${n('cpty_only')} AS n_cpty_only,
    ${n('both')} AS n_both,
    ${n('divergence')} AS n_divergence,
    ${n('no_verifiable_rules')} AS n_no_rules
  FROM (SELECT * FROM break_verdict WHERE business_date = ${d} ORDER BY breaking_field) bv
  GROUP BY ${keys}
) g`;
}

/**
 * Rule result tables created before 2026-10-21 have Portuguese identifiers (verdicts so_bnpp/divergencia...,
 * columns campo/valor_bnpp/n_so_bnpp...). Probe queries: if any succeeds, the tables are legacy and must be dropped
 * (every business date then needs `npm run rules` again).
 */
export const LEGACY_PROBES = [
  'SELECT campo FROM break_detail LIMIT 0',
  'SELECT n_so_bnpp FROM key_summary LIMIT 0',
  "SELECT 1 FROM break_verdict WHERE verdict IN ('so_bnpp', 'so_contraparte', 'ambos', 'divergencia', 'sem_regras_verificaveis') LIMIT 1",
];
export const RULE_TABLES = ['rule_results', 'break_verdict', 'break_detail', 'key_summary'];

/** true if the database still has rule tables with the legacy (Portuguese) schema or values. */
export async function hasLegacyRuleTables(db) {
  for (const sql of LEGACY_PROBES) {
    try {
      const rows = await db.all(sql);
      if (!sql.includes('LIMIT 1') || rows.length) return true;
    } catch {
      // table or column does not exist: not legacy
    }
  }
  return false;
}
