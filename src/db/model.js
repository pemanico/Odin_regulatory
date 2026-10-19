// Modelo lógico dos breaks: nomes de colunas estáveis usados pela semantic layer,
// independentes dos nomes físicos (Oracle/Parquet) definidos em config/default.json.

/** Colunas lógicas expostas em breaks_raw e breaks, pela ordem. */
export const LOGICAL_COLUMNS = [
  'rec_stat_id',
  'business_date',
  'uti',
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

/**
 * Colunas físicas que não são colunas lógicas, mas alimentam uma delas:
 *  - uti_alt: o identificador do trade vem em UTI **ou** em PROPRIETARY (mutuamente exclusivos);
 *    a coluna lógica `uti` é o primeiro não vazio dos dois.
 */
export const AUXILIARY_COLUMNS = ['uti_alt'];

/** Chave de um break (grão da vista deduplicada). */
export const BREAK_KEY = ['business_date', 'uti', 'cp1_lei', 'cp2_lei', 'breaking_field'];

/** Chave de uma position (vários breaks por position). */
export const POSITION_KEY = ['uti', 'cp1_lei', 'cp2_lei'];

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
    if (logical === 'uti' && cols.uti_alt) {
      // SQL standard (COALESCE/NULLIF/TRIM): igual em DuckDB, ClickHouse e SQLite.
      const nonEmpty = (r) => `NULLIF(TRIM(${dialect.castText(r)}), '')`;
      return `COALESCE(${nonEmpty(ref)}, ${nonEmpty(quoteIdent(cols.uti_alt))}) AS uti`;
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
