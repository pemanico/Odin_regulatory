// Agent tools (next phase). The backend API exposes the SAME operations (plan approved on 2026-10-20):
//   list_metrics   -> GET  /api/metrics
//   query_metric   -> POST /api/query
//   open_drilldown -> does not call the backend: returns the screen 3 filters to the UI (the UI shows the rows).
// Architecture rule: the LLM only sees aggregates. The endpoints with rows (/api/keys) are UI only and are NEVER tools.
import { DIMENSIONS, FILTER_OPS, METRICS } from '../semantic/catalog.js';
import { VERDICTS, KEY_VERDICTS } from '../rules/sql.js';

export const AGENT_TOOLS = [
  {
    name: 'list_metrics',
    description:
      'Lists the certified metrics (EMIR breaks): id, description, allowed dimensions and filters, required filters. ' +
      'Call it before query_metric when unsure which metric is right.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'query_metric',
    description:
      'Runs a certified metric and returns AGGREGATED rows (counts). Never returns individual breaks. ' +
      'business_date is required in every metric (format YYYY-MM-DD).',
    input_schema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: Object.keys(METRICS).filter((m) => METRICS[m].kind !== 'pending') },
        dimensions: { type: 'array', items: { type: 'string', enum: Object.keys(DIMENSIONS) }, maxItems: 4 },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              dimension: { type: 'string', enum: Object.keys(DIMENSIONS) },
              op: { type: 'string', enum: FILTER_OPS },
              value: {},
            },
            required: ['dimension', 'op', 'value'],
          },
        },
        limit: { type: 'integer', minimum: 1, maximum: 10000 },
      },
      required: ['metric', 'filters'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_drilldown',
    description:
      'Opens the drill-down screen so that the operations user can see the breaks (the rows are shown by the UI; the agent does not see them). ' +
      'Use it after an aggregated answer, so that the user can check the evidence.',
    input_schema: {
      type: 'object',
      properties: {
        business_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        breaking_field: { type: 'string' },
        field_verdict: { type: 'string', enum: VERDICTS },
        key_verdict: { type: 'string', enum: KEY_VERDICTS },
        combo: { type: 'string', description: 'Field combination in the format |A|B| (combo_key from field_combinations)' },
        asset_class: { type: 'string' },
      },
      required: ['business_date'],
      additionalProperties: false,
    },
  },
];
