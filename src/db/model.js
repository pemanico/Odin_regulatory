// Modelo lógico dos breaks: nomes de colunas estáveis usados pela semantic layer,
// independentes dos nomes físicos (Oracle/Parquet) definidos em config/default.json.

/** Colunas lógicas expostas em breaks_raw e breaks, pela ordem. */
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

/** Identificadores do trade: vêm em UTI **ou** em PROPRIETARY (mutuamente exclusivos). Texto vazio = NULL. */
const ID_TEXT_COLUMNS = ['uti', 'proprietary'];

/**
 * Chave de uma position = a chave de produção sem o campo:
 *   RANK() OVER (PARTITION BY BREAKING_FIELD, REPORTING_COUNTERPARTY_LEI, OTHER_COUNTERPARTY_LEGAL_LEI,
 *                REPORT_SUBMITTING_ENTITY, UTI, PROPRIETARY, C_PRIMARY_ASSET_CLASS ...)
 * UTI e PROPRIETARY entram como colunas separadas (como em produção e no ficheiro DTCC), não em COALESCE.
 */
export const POSITION_KEY = ['report_submitting_entity', 'cp1_lei', 'cp2_lei', 'uti', 'proprietary', 'asset_class'];

/** Chave de um break (grão da vista deduplicada) = business date + position + campo. */
export const BREAK_KEY = ['business_date', ...POSITION_KEY, 'breaking_field'];

/** Identificador do trade para mostrar/agregar: o que estiver preenchido (UTI ou PROPRIETARY). */
export function tradeIdExpr(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `COALESCE(${p}uti, ${p}proprietary)`;
}

/** Expressão SQL standard que identifica uma position (NULL-safe). */
export function positionKeyExpr(alias = '') {
  const p = alias ? `${alias}.` : '';
  return POSITION_KEY.map((c) => `COALESCE(${p}${c}, '')`).join(` || '|' || `);
}

const quoteIdent = (name) => `"${name}"`;

/**
 * SELECT que converte as colunas físicas da fonte para o modelo lógico.
 * Colunas lógicas sem mapeamento na config ficam NULL.
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
      // SQL standard (NULLIF/TRIM): igual em DuckDB, ClickHouse e SQLite.
      return `NULLIF(TRIM(${dialect.castText(ref)}), '') AS ${logical}`;
    }
    return `${dialect.castText(ref)} AS ${logical}`;
  });
  return `SELECT\n  ${parts.join(',\n  ')}\nFROM ${fromSql}`;
}

/**
 * Vista deduplicada: uma linha por break (BREAK_KEY).
 * Mantém a linha com o menor rec_stat_id. Duplicados com valores diferentes
 * são reportados pela métrica data_quality (conflicting_keys), não escondidos.
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
 * Instruções para criar breaks_raw e breaks numa base acabada de criar.
 * `materialize=true` cria tabelas (rápido para consultas repetidas); false cria vistas.
 */
export function buildModelStatements(config, dialect, fromSql, { materialize = true } = {}) {
  const kind = materialize ? 'TABLE' : 'VIEW';
  return [
    `CREATE ${kind} breaks_raw AS\n${logicalSelect(config, dialect, fromSql)}`,
    `CREATE ${kind} breaks AS\n${dedupSelect('breaks_raw')}`,
  ];
}
