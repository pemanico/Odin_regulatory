// Tools do agente (fase seguinte). A API do backend expõe as MESMAS operações (plano aprovado em 2026-10-20):
//   list_metrics   -> GET  /api/metrics
//   query_metric   -> POST /api/query
//   open_drilldown -> não chama o backend: devolve à UI os filtros do ecrã 3 (a UI mostra as linhas).
// Regra de arquitetura: o LLM só vê agregados. Os endpoints com linhas (/api/keys) são só da UI e NUNCA são tools.
import { DIMENSIONS, FILTER_OPS, METRICS } from '../semantic/catalog.js';
import { VERDICTS, KEY_VERDICTS } from '../rules/sql.js';

export const AGENT_TOOLS = [
  {
    name: 'list_metrics',
    description:
      'Lista as métricas certificadas (EMIR breaks): id, descrição, dimensões e filtros permitidos, filtros obrigatórios. ' +
      'Chamar antes de query_metric se houver dúvida sobre a métrica certa.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'query_metric',
    description:
      'Corre uma métrica certificada e devolve linhas AGREGADAS (contagens). Nunca devolve breaks individuais. ' +
      'business_date é obrigatório em todas as métricas (formato YYYY-MM-DD).',
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
      'Abre o ecrã de drill-down para o operacional ver os breaks (as linhas são mostradas pela UI; o agente não as vê). ' +
      'Usar depois de uma resposta agregada, para o utilizador verificar a evidência.',
    input_schema: {
      type: 'object',
      properties: {
        business_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        breaking_field: { type: 'string' },
        field_verdict: { type: 'string', enum: VERDICTS },
        key_verdict: { type: 'string', enum: KEY_VERDICTS },
        combo: { type: 'string', description: 'Combinação de campos no formato |A|B| (combo_key de field_combinations)' },
        asset_class: { type: 'string' },
      },
      required: ['business_date'],
      additionalProperties: false,
    },
  },
];
