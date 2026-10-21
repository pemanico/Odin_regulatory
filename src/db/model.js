// Logical model of the breaks: stable column names used by the semantic layer,
// independent of the physical names (Oracle/Parquet) defined in config/default.json.

/** Logical columns exposed in breaks_raw and breaks, in order. */
export const LOGICAL_COLUMNS = [
  'rec_stat_id',
  'business_date',
  'report_submitting_entity',
  'uti',
  'proprietary',
  'cp1_lei',
  'cp2_lei',
  'breaking_field',
  'bnpp_value',
  'cpty_value',
  'asset_class',
  'rec_category',
  'pairing',
  'reconciliation',
  'valuation_reconciliation',
  'business_line',
  'activity_l1',
  'activity_l2',
  'activity_l3',
  'activity_l4',
  'cpty_crds_code',
  'trade_number',
];

/** Trade identifiers: they come in UTI **or** in PROPRIETARY (mutually exclusive). Empty text = NULL. */
const ID_TEXT_COLUMNS = ['uti', 'proprietary'];

/**
 * Key of a position = the production key without the field:
 *   RANK() OVER (PARTITION BY BREAKING_FIELD, REPORTING_COUNTERPARTY_LEI, OTHER_COUNTERPARTY_LEGAL_LEI,
 *                REPORT_SUBMITTING_ENTITY, UTI, PROPRIETARY, C_PRIMARY_ASSET_CLASS ...)
 * UTI and PROPRIETARY are separate columns (as in production and in the DTCC file), not a COALESCE.
 */
export const POSITION_KEY = ['report_submitting_entity', 'cp1_lei', 'cp2_lei', 'uti', 'proprietary', 'asset_class'];

/** Key of a break (grain of the deduplicated view) = business date + position + field. */
export const BREAK_KEY = ['business_date', ...POSITION_KEY, 'breaking_field'];

/** Trade identifier to show/aggregate: whichever is populated (UTI or PROPRIETARY). */
export function tradeIdExpr(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `COALESCE(${p}uti, ${p}proprietary)`;
}

/** Standard SQL expression identifying a position (NULL-safe). */
export function positionKeyExpr(alias = '') {
  const p = alias ? `${alias}.` : '';
  return POSITION_KEY.map((c) => `COALESCE(${p}${c}, '')`).join(` || '|' || `);
}

const quoteIdent = (name) => `"${name}"`;

/**
 * SELECT converting the source's physical columns to the logical model.
 * Logical columns without a mapping in the config are NULL.
 */
export function logicalSelect(config, dialect, fromSql) {
  const cols = config.columns;
  const parts = LOGICAL_COLUMNS.map((logical) => {
    const physical = cols[logical];
    if (!physical) return `NULL AS ${logical}`;
    const ref = quoteIdent(physical);
    if (logical === 'business_date') {
      return `${dialect.castDate(ref, config.source?.businessDateFormat)} AS business_date`;
    }
    if (logical === 'rec_stat_id') return `${ref} AS ${logical}`;
    if (ID_TEXT_COLUMNS.includes(logical)) {
      // Standard SQL (NULLIF/TRIM): the same in DuckDB, ClickHouse and SQLite.
      return `NULLIF(TRIM(${dialect.castText(ref)}), '') AS ${logical}`;
    }
    return `${dialect.castText(ref)} AS ${logical}`;
  });
  return `SELECT\n  ${parts.join(',\n  ')}\nFROM ${fromSql}`;
}

/**
 * Deduplicated view: one row per break (BREAK_KEY).
 * Keeps the row with the lowest rec_stat_id. Duplicates with different values
 * are reported by the data_quality metric (conflicting_keys), not hidden.
 */
export function dedupSelect(rawTable = 'breaks_raw') {
  return `SELECT ${LOGICAL_COLUMNS.join(', ')}
FROM (
  SELECT r.*,
         ROW_NUMBER() OVER (PARTITION BY ${BREAK_KEY.join(', ')} ORDER BY rec_stat_id) AS rn
  FROM ${rawTable} r
) t
WHERE rn = 1`;
}

/**
 * Statements creating breaks_raw and breaks in a freshly created database.
 * `materialize=true` creates tables (fast for repeated queries); false creates views.
 */
export function buildModelStatements(config, dialect, fromSql, { materialize = true } = {}) {
  const kind = materialize ? 'TABLE' : 'VIEW';
  return [
    `CREATE ${kind} breaks_raw AS\n${logicalSelect(config, dialect, fromSql)}`,
    `CREATE ${kind} breaks AS\n${dedupSelect('breaks_raw')}`,
  ];
}
