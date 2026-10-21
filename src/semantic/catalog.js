// Semantic layer — catalog of certified metrics.
// Each metric has a FIXED, documented grain, measure, dimensions and filters.
// The LLM only picks metric + dimensions + filters from this catalog; it never writes SQL.
//
// Base grain: 1 distinct break = BUSINESS_DATE + production key (REPORT_SUBMITTING_ENTITY, LEI CP1, LEI CP2,
// UTI, PROPRIETARY, ASSET_CLASS, BREAKING_FIELD) — `breaks` view.

/** Allowed dimensions (whitelist). The key is the logical column name. */
export const DIMENSIONS = {
  business_date: { type: 'date', label: 'Business date' },
  breaking_field: { type: 'string', label: 'Breaking field' },
  asset_class: { type: 'string', label: 'Asset class' },
  cp1_lei: { type: 'string', label: 'Counterparty 1 LEI' },
  cp2_lei: { type: 'string', label: 'Counterparty 2 LEI (other counterparty)' },
  business_line: { type: 'string', label: 'Business line' },
  activity_l1: { type: 'string', label: 'Activity L1' },
  activity_l2: { type: 'string', label: 'Activity L2' },
  activity_l3: { type: 'string', label: 'Activity L3' },
  activity_l4: { type: 'string', label: 'Activity L4' },
  rec_category: { type: 'string', label: 'DTCC category' },
  pairing: { type: 'string', label: 'Pairing status' },
  reconciliation: { type: 'string', label: 'Reconciliation status' },
  valuation_reconciliation: { type: 'string', label: 'Valuation reconciliation status' },
  verdict: { type: 'string', label: 'ESMA rules verdict (bnpp_only, cpty_only, both, divergence, no_verifiable_rules)' },
  key_verdict: { type: 'string', label: 'Transaction/Key verdict (bnpp, counterparty, mixed, unexplained)' },
};

/** Allowed filter operators. */
export const FILTER_OPS = ['eq', 'in', 'between', 'gte', 'lte'];

/**
 * Certified metrics (the 6 of the approved plan + persistence, 2026-10-19 + rule_verdict, key_verdict and
 * field_combinations, 2026-10-20).
 * kind:
 *  - 'aggregate': SELECT dims, measure FROM table GROUP BY dims (generic compiler)
 *  - 'custom':    its own SQL, built in compiler.js
 *  - 'pending':   not available yet (information missing)
 */
export const METRICS = {
  breaks_by_field: {
    kind: 'aggregate',
    title: 'Breaks by field',
    description: 'Number of distinct breaks per BREAKING_FIELD. Grain: distinct (deduplicated) break.',
    from: 'breaks',
    measure: { name: 'n_breaks', sql: 'COUNT(*)' },
    defaultDimensions: ['breaking_field'],
    allowedDimensions: Object.keys(DIMENSIONS),
    requiredFilters: ['business_date'],
    defaultLimit: 100,
  },
  breaks_dod: {
    kind: 'custom',
    title: 'Day-on-day change',
    description:
      'Distinct breaks per field on the requested business date vs. the previous business date AVAILABLE in the data ' +
      '(not the previous calendar day: weekends, holidays and dates excluded in the config are skipped).',
    requiredFilters: ['business_date'],
    requiredOps: { business_date: ['eq'] },
    allowedFilterDimensions: Object.keys(DIMENSIONS).filter((d) => d !== 'business_date'),
    defaultLimit: 20,
  },
  persistence: {
    kind: 'custom',
    title: 'Persistence vs. the previous day',
    description:
      'Classifies the distinct breaks of the requested business date (D) against the previous available business date ' +
      '(D-1, skipping excluded dates): same (same key and same BNPP and CPTY values, NULL = NULL), changed (same key, ' +
      'some value different), new (key only in D) and resolved (key only in D-1). Percentages are over the breaks of D. ' +
      'It is a POTENTIAL for inheriting the categorisation, not a saving (the backtest against the history is missing). ' +
      'Dimensions and filters use the value of D (the value of D-1 for resolved breaks).',
    requiredFilters: ['business_date'],
    requiredOps: { business_date: ['eq'] },
    allowedDimensions: ['breaking_field', 'asset_class'],
    defaultDimensions: [],
    allowedFilterDimensions: Object.keys(DIMENSIONS).filter((d) => d !== 'business_date'),
    defaultLimit: 100,
  },
  rule_verdict: {
    kind: 'aggregate',
    title: 'Breaks by ESMA rules verdict',
    description:
      'Distinct breaks per verdict of the rules engine (ESMA validation rules applied to TP1 = BNPP and TP2 = counterparty): ' +
      'bnpp_only, cpty_only, both, divergence (both values comply with the verifiable rules) and ' +
      'no_verifiable_rules. Requires npm run rules for the business date.',
    from: 'break_verdict',
    measure: { name: 'n_breaks', sql: 'COUNT(*)' },
    defaultDimensions: ['verdict'],
    allowedDimensions: ['verdict', 'breaking_field', 'business_date', 'asset_class', 'cp2_lei'],
    allowedFilterDimensions: ['business_date', 'verdict', 'breaking_field', 'asset_class', 'cp2_lei'],
    requiredFilters: ['business_date'],
    defaultLimit: 100,
  },
  key_verdict: {
    kind: 'aggregate',
    title: 'Transactions (Keys) by verdict',
    description:
      'Distinct transactions (Key = production key without the field) per Key verdict: bnpp (only fields with an error ' +
      'on the BNPP side), counterparty (only on the counterparty side), mixed (errors on both sides, in different fields ' +
      'or in the same field) and unexplained (no field with the wrong side identified by the ESMA rules). Requires npm run rules.',
    from: 'key_summary',
    measure: { name: 'n_keys', sql: 'COUNT(*)' },
    defaultDimensions: ['key_verdict'],
    allowedDimensions: ['key_verdict', 'business_date', 'asset_class', 'cp2_lei'],
    allowedFilterDimensions: ['business_date', 'key_verdict', 'asset_class', 'cp2_lei'],
    requiredFilters: ['business_date'],
    defaultLimit: 100,
  },
  field_combinations: {
    kind: 'custom',
    title: 'Combinations of breaking fields per transaction',
    description:
      'Sets of breaking fields that occur together in the same transaction (Key), with the number of transactions and ' +
      'the Key verdicts. The breaking_field filter returns the combinations that CONTAIN that field. Requires npm run rules.',
    requiredFilters: ['business_date'],
    requiredOps: { business_date: ['eq'], breaking_field: ['eq'] },
    allowedFilterDimensions: ['business_date', 'breaking_field', 'asset_class', 'key_verdict', 'cp2_lei'],
    defaultLimit: 20,
  },
  top_fields: {
    kind: 'aggregate',
    title: 'Top N breaking fields',
    description: 'The N fields with the most distinct breaks on a business date (or range).',
    from: 'breaks',
    measure: { name: 'n_breaks', sql: 'COUNT(*)' },
    defaultDimensions: ['breaking_field'],
    allowedDimensions: ['breaking_field'],
    requiredFilters: ['business_date'],
    defaultLimit: 10,
  },
  breaks_by_counterparty: {
    kind: 'aggregate',
    title: 'Breaks by counterparty',
    description: 'Distinct breaks per counterparty LEI (counterparty 2), optionally per field.',
    from: 'breaks',
    measure: { name: 'n_breaks', sql: 'COUNT(*)' },
    defaultDimensions: ['cp2_lei'],
    allowedDimensions: ['cp2_lei', 'breaking_field', 'business_date', 'asset_class', 'business_line'],
    requiredFilters: ['business_date'],
    defaultLimit: 20,
  },
  reference_id_distribution: {
    kind: 'pending',
    title: 'Reference ID distribution (history)',
    description: 'How many times each reference ID was applied by operations, per field.',
    pendingReason:
      'The schema of the categorisation history (key columns + reference ID) and of the reference ID table is missing. ' +
      'See CLAUDE.md, open questions.',
  },
  data_quality: {
    kind: 'custom',
    title: 'Data quality: raw rows vs. distinct breaks',
    description:
      'Per business date: raw rows, distinct breaks, distinct positions, duplication factor and ' +
      'break keys with different values across duplicates (conflicting_keys).',
    requiredFilters: ['business_date'],
    allowedFilterDimensions: [],
    defaultLimit: 366,
  },
};

/** Catalog description for the agent (tool schema) and the UI. */
export function describeCatalog() {
  return {
    grain: 'distinct break = BUSINESS_DATE + REPORT_SUBMITTING_ENTITY + LEI CP1 + LEI CP2 + UTI + PROPRIETARY + ASSET_CLASS + BREAKING_FIELD (production key)',
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
