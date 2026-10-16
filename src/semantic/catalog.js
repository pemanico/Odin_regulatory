// Semantic layer — catálogo de métricas certificadas.
// Cada métrica tem grão, medida, dimensões e filtros FIXOS e documentados.
// O LLM (fase 6–8) só escolhe métrica + dimensões + filtros deste catálogo; nunca escreve SQL.
//
// Grão base: 1 break distinto = BUSINESS_DATE + UTI + LEI CP1 + LEI CP2 + BREAKING_FIELD (vista `breaks`).

/** Dimensões permitidas (whitelist). A chave é o nome lógico da coluna. */
export const DIMENSIONS = {
  business_date: { type: 'date', label: 'Business date' },
  breaking_field: { type: 'string', label: 'Campo em break' },
  asset_class: { type: 'string', label: 'Asset class' },
  cp1_lei: { type: 'string', label: 'LEI counterparty 1' },
  cp2_lei: { type: 'string', label: 'LEI counterparty 2 (contraparte)' },
  business_line: { type: 'string', label: 'Business line' },
  activity_l1: { type: 'string', label: 'Atividade L1' },
  activity_l2: { type: 'string', label: 'Atividade L2' },
  activity_l3: { type: 'string', label: 'Atividade L3' },
  activity_l4: { type: 'string', label: 'Atividade L4' },
  rec_category: { type: 'string', label: 'Categoria DTCC' },
  pairing: { type: 'string', label: 'Estado de pairing' },
  reconciliation: { type: 'string', label: 'Estado de reconciliação' },
  valuation_reconciliation: { type: 'string', label: 'Estado de reconciliação de valuation' },
};

/** Operadores de filtro permitidos. */
export const FILTER_OPS = ['eq', 'in', 'between', 'gte', 'lte'];

/**
 * Métricas certificadas (as 6 do plano aprovado).
 * kind:
 *  - 'aggregate': SELECT dims, medida FROM tabela GROUP BY dims (compilador genérico)
 *  - 'custom':    SQL próprio, construído em compiler.js
 *  - 'pending':   ainda indisponível (falta informação)
 */
export const METRICS = {
  breaks_by_field: {
    kind: 'aggregate',
    title: 'Breaks por campo',
    description: 'Número de breaks distintos por BREAKING_FIELD. Grão: break distinto (deduplicado).',
    from: 'breaks',
    measure: { name: 'n_breaks', sql: 'COUNT(*)' },
    defaultDimensions: ['breaking_field'],
    allowedDimensions: Object.keys(DIMENSIONS),
    requiredFilters: ['business_date'],
    defaultLimit: 100,
  },
  breaks_dod: {
    kind: 'custom',
    title: 'Variação face ao dia anterior',
    description:
      'Breaks distintos por campo na business date pedida vs. a business date anterior DISPONÍVEL nos dados ' +
      '(não o dia de calendário anterior: fins de semana e feriados são saltados).',
    requiredFilters: ['business_date'],
    requiredOps: { business_date: ['eq'] },
    allowedFilterDimensions: Object.keys(DIMENSIONS).filter((d) => d !== 'business_date'),
    defaultLimit: 20,
  },
  top_fields: {
    kind: 'aggregate',
    title: 'Top N de campos em break',
    description: 'Os N campos com mais breaks distintos numa business date (ou intervalo).',
    from: 'breaks',
    measure: { name: 'n_breaks', sql: 'COUNT(*)' },
    defaultDimensions: ['breaking_field'],
    allowedDimensions: ['breaking_field'],
    requiredFilters: ['business_date'],
    defaultLimit: 10,
  },
  breaks_by_counterparty: {
    kind: 'aggregate',
    title: 'Breaks por contraparte',
    description: 'Breaks distintos por LEI da contraparte (counterparty 2), opcionalmente por campo.',
    from: 'breaks',
    measure: { name: 'n_breaks', sql: 'COUNT(*)' },
    defaultDimensions: ['cp2_lei'],
    allowedDimensions: ['cp2_lei', 'breaking_field', 'business_date', 'asset_class', 'business_line'],
    requiredFilters: ['business_date'],
    defaultLimit: 20,
  },
  reference_id_distribution: {
    kind: 'pending',
    title: 'Distribuição de reference IDs (histórico)',
    description: 'Quantas vezes cada reference ID foi aplicado pelos operacionais, por campo.',
    pendingReason:
      'Falta o schema do histórico de categorizações (colunas da chave + reference ID) e da tabela de reference IDs. ' +
      'Ver CLAUDE.md, questões em aberto.',
  },
  data_quality: {
    kind: 'custom',
    title: 'Qualidade de dados: linhas brutas vs. breaks distintos',
    description:
      'Por business date: linhas brutas, breaks distintos, positions distintas, fator de duplicação e ' +
      'chaves de break com valores diferentes entre duplicados (conflicting_keys).',
    requiredFilters: ['business_date'],
    allowedFilterDimensions: [],
    defaultLimit: 366,
  },
};

/** Descrição do catálogo para o agente (tool schema) e para a UI. */
export function describeCatalog() {
  return {
    grain: 'break distinto = BUSINESS_DATE + UTI + LEI CP1 + LEI CP2 + BREAKING_FIELD',
    metrics: Object.entries(METRICS).map(([id, m]) => ({
      id,
      title: m.title,
      description: m.description,
      available: m.kind !== 'pending',
      ...(m.kind === 'pending' ? { pendingReason: m.pendingReason } : {}),
      ...(m.allowedDimensions ? { allowedDimensions: m.allowedDimensions, defaultDimensions: m.defaultDimensions } : {}),
      requiredFilters: m.requiredFilters ?? [],
      defaultLimit: m.defaultLimit,
    })),
    dimensions: DIMENSIONS,
    filterOps: FILTER_OPS,
  };
}
