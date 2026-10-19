// Compilador da semantic layer: pedido estruturado -> SQL standard.
// Pedido: { metric, dimensions?, filters?: [{ dimension, op, value }], limit? }
// Garantias:
//  - identificadores só do catálogo (whitelist);
//  - valores validados por tipo e escapados (literals.js);
//  - grão e medida fixos por métrica: a mesma pergunta dá sempre o mesmo número.
import { METRICS, DIMENSIONS, FILTER_OPS } from './catalog.js';
import { ValidationError, literalFor, intValue, isValidDate } from './literals.js';
import { positionKeyExpr } from '../db/model.js';
import { previousDateSql, assertNotExcluded } from './calendar.js';

export class MetricUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MetricUnavailableError';
  }
}

const MAX_DIMENSIONS = 4;
const MAX_IN_VALUES = 100;

function getMetric(id) {
  const metric = METRICS[id];
  if (!metric) {
    throw new ValidationError(`Métrica desconhecida: ${JSON.stringify(id)}. Disponíveis: ${Object.keys(METRICS).join(', ')}`);
  }
  if (metric.kind === 'pending') throw new MetricUnavailableError(`${metric.title}: indisponível. ${metric.pendingReason}`);
  return metric;
}

/** Renderiza um filtro como condição SQL. `allowed` = dimensões filtráveis nesta métrica. */
export function renderFilter(filter, allowed) {
  const { dimension, op, value } = filter ?? {};
  const dim = DIMENSIONS[dimension];
  if (!dim || !allowed.includes(dimension)) {
    throw new ValidationError(`Filtro não permitido nesta métrica: ${JSON.stringify(dimension)}`);
  }
  if (!FILTER_OPS.includes(op)) throw new ValidationError(`Operador de filtro inválido: ${JSON.stringify(op)}`);
  const lit = (v) => literalFor(dim.type, v);

  switch (op) {
    case 'eq':
      return `${dimension} = ${lit(value)}`;
    case 'gte':
      return `${dimension} >= ${lit(value)}`;
    case 'lte':
      return `${dimension} <= ${lit(value)}`;
    case 'in': {
      if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IN_VALUES) {
        throw new ValidationError(`"in" exige uma lista com 1 a ${MAX_IN_VALUES} valores`);
      }
      return `${dimension} IN (${value.map(lit).join(', ')})`;
    }
    case 'between': {
      if (!Array.isArray(value) || value.length !== 2) throw new ValidationError('"between" exige [início, fim]');
      const [a, b] = value;
      if (dim.type === 'date' && isValidDate(a) && isValidDate(b) && a > b) {
        throw new ValidationError(`Intervalo de datas invertido: ${a} > ${b}`);
      }
      return `${dimension} BETWEEN ${lit(a)} AND ${lit(b)}`;
    }
    default:
      throw new ValidationError(`Operador não suportado: ${op}`);
  }
}

function checkRequired(metric, filters) {
  for (const req of metric.requiredFilters ?? []) {
    const f = filters.find((x) => x?.dimension === req);
    if (!f) throw new ValidationError(`Filtro obrigatório em falta: ${req}`);
    const ops = metric.requiredOps?.[req];
    if (ops && !ops.includes(f.op)) {
      throw new ValidationError(`O filtro ${req} desta métrica só aceita: ${ops.join(', ')}`);
    }
  }
}

function whereClause(conditions) {
  return conditions.length ? `WHERE ${conditions.join('\n  AND ')}` : '';
}

function resolveLimit(metric, limit) {
  return limit === undefined || limit === null ? metric.defaultLimit : intValue(limit, { min: 1, max: 10000 });
}

function compileAggregate(id, metric, req) {
  const dims = [...new Set(req.dimensions ?? metric.defaultDimensions)];
  if (dims.length > MAX_DIMENSIONS) throw new ValidationError(`Máximo de ${MAX_DIMENSIONS} dimensões`);
  for (const d of dims) {
    if (!metric.allowedDimensions.includes(d)) {
      throw new ValidationError(`Dimensão não permitida em ${id}: ${JSON.stringify(d)}`);
    }
  }
  const filters = req.filters ?? [];
  checkRequired(metric, filters);
  const conditions = filters.map((f) => renderFilter(f, Object.keys(DIMENSIONS)));
  const limit = resolveLimit(metric, req.limit);
  const m = metric.measure;

  const select = [...dims, `${m.sql} AS ${m.name}`].join(', ');
  const groupBy = dims.length ? `\nGROUP BY ${dims.join(', ')}` : '';
  const orderParts = dims.includes('business_date') ? ['business_date', `${m.name} DESC`] : [`${m.name} DESC`];
  orderParts.push(...dims.filter((d) => d !== 'business_date'));
  const orderBy = dims.length ? `\nORDER BY ${orderParts.join(', ')}` : '';

  return {
    sql: `SELECT ${select}\nFROM ${metric.from}\n${whereClause(conditions)}${groupBy}${orderBy}\nLIMIT ${limit}`,
    postprocess: (rows) => rows,
  };
}

function compileDod(metric, req, opts) {
  const filters = req.filters ?? [];
  checkRequired(metric, filters);
  const dateFilter = filters.find((f) => f.dimension === 'business_date');
  const date = literalFor('date', dateFilter.value);
  assertNotExcluded(dateFilter.value, opts.excludedDates);
  const others = filters
    .filter((f) => f.dimension !== 'business_date')
    .map((f) => renderFilter(f, metric.allowedFilterDimensions));
  const extra = others.length ? `\n    AND ${others.join('\n    AND ')}` : '';
  const limit = resolveLimit(metric, req.limit);

  const sql = `WITH prev AS (
  ${previousDateSql(dateFilter.value, opts.excludedDates)}
),
cur AS (
  SELECT breaking_field, COUNT(*) AS n FROM breaks
  WHERE business_date = ${date}${extra}
  GROUP BY breaking_field
),
pre AS (
  SELECT breaking_field, COUNT(*) AS n FROM breaks
  WHERE business_date = (SELECT d FROM prev)${extra}
  GROUP BY breaking_field
)
SELECT
  COALESCE(c.breaking_field, p.breaking_field) AS breaking_field,
  (SELECT d FROM prev) AS previous_date,
  COALESCE(c.n, 0) AS today,
  COALESCE(p.n, 0) AS previous,
  COALESCE(c.n, 0) - COALESCE(p.n, 0) AS delta
FROM cur c
FULL OUTER JOIN pre p ON c.breaking_field = p.breaking_field
ORDER BY today DESC, previous DESC, breaking_field
LIMIT ${limit}`;

  return {
    sql,
    postprocess: (rows) =>
      rows.map((r) => ({
        ...r,
        delta_pct: Number(r.previous) > 0 ? Math.round((Number(r.delta) / Number(r.previous)) * 1000) / 10 : null,
      })),
  };
}

/** NULL-safe e SQL standard (sem IS NOT DISTINCT FROM, que nem todos os motores aceitam fora de JOIN). */
const sameValue = (a, b) => `(${a} = ${b} OR (${a} IS NULL AND ${b} IS NULL))`;
/** Igualdade das colunas da chave (o uti já vem com COALESCE(UTI, PROPRIETARY)). */
const sameKey = (a, b) => `COALESCE(${a}, '') = COALESCE(${b}, '')`;
const PERSISTENCE_KEY = ['uti', 'cp1_lei', 'cp2_lei', 'breaking_field'];
const PERSISTENCE_STATUSES = ['igual', 'alterado', 'novo', 'resolvido'];

function compilePersistence(metric, req, opts) {
  const filters = req.filters ?? [];
  checkRequired(metric, filters);
  const dateFilter = filters.find((f) => f.dimension === 'business_date');
  const date = literalFor('date', dateFilter.value);
  assertNotExcluded(dateFilter.value, opts.excludedDates);

  const dims = [...new Set(req.dimensions ?? metric.defaultDimensions)];
  for (const d of dims) {
    if (!metric.allowedDimensions.includes(d)) {
      throw new ValidationError(`Dimensão não permitida em persistence: ${JSON.stringify(d)}`);
    }
  }
  const others = filters.filter((f) => f.dimension !== 'business_date');
  const conditions = others.map((f) => renderFilter(f, metric.allowedFilterDimensions));
  const limit = resolveLimit(metric, req.limit);

  // Colunas de dimensão necessárias (agrupamento + filtros). O valor de D prevalece; nos resolvidos, o de D-1.
  const dimCols = [...new Set([...dims, ...others.map((f) => f.dimension)])].filter((d) => !PERSISTENCE_KEY.includes(d));
  const sideCols = [...PERSISTENCE_KEY, 'bnpp_value', 'cpty_value', ...dimCols].join(', ');
  const joinedDims = [...new Set([...dims, ...others.map((f) => f.dimension)])]
    .map((d) => `COALESCE(c.${d}, p.${d}) AS ${d}`)
    .join(',\n    ');
  const status = `CASE
      WHEN p.present IS NULL THEN 'novo'
      WHEN c.present IS NULL THEN 'resolvido'
      WHEN ${sameValue('c.bnpp_value', 'p.bnpp_value')} AND ${sameValue('c.cpty_value', 'p.cpty_value')} THEN 'igual'
      ELSE 'alterado'
    END`;
  const count = (s) => `SUM(CASE WHEN status = '${s}' THEN 1 ELSE 0 END) AS ${s}`;
  const select = [
    ...dims,
    '(SELECT d FROM prev) AS previous_date',
    ...PERSISTENCE_STATUSES.map(count),
  ].join(',\n  ');
  const where = whereClause([`EXISTS (SELECT 1 FROM breaks WHERE business_date = ${date})`, ...conditions]);
  const groupBy = dims.length ? `\nGROUP BY ${dims.join(', ')}` : '';
  const todayCount = `SUM(CASE WHEN status IN ('igual', 'alterado', 'novo') THEN 1 ELSE 0 END)`;
  const orderBy = dims.length ? `\nORDER BY ${todayCount} DESC, ${dims.join(', ')}` : '';

  const sql = `WITH prev AS (
  ${previousDateSql(dateFilter.value, opts.excludedDates)}
),
cur AS (
  SELECT ${sideCols}, 1 AS present FROM breaks WHERE business_date = ${date}
),
pre AS (
  SELECT ${sideCols}, 1 AS present FROM breaks WHERE business_date = (SELECT d FROM prev)
),
j AS (
  SELECT
    ${joinedDims ? `${joinedDims},\n    ` : ''}${status} AS status
  FROM cur c
  FULL OUTER JOIN pre p
    ON ${PERSISTENCE_KEY.map((k) => sameKey(`c.${k}`, `p.${k}`)).join('\n   AND ')}
)
SELECT
  ${select}
FROM j
${where}${groupBy}${orderBy}
LIMIT ${limit}`;

  return {
    sql,
    postprocess: (rows) =>
      rows
        // Sem GROUP BY, um agregado sobre zero linhas devolve uma linha de NULLs: descartar (data sem dados).
        .filter((r) => PERSISTENCE_STATUSES.some((s) => Number(r[s] ?? 0) > 0))
        .map(persistenceRow),
  };
}

const pct = (n, total) => (total > 0 ? Math.round((n / total) * 1000) / 10 : null);

/** Converte as contagens, calcula totais e percentagens (sobre os breaks de D). */
function persistenceRow(r) {
  const out = { ...r };
  for (const s of PERSISTENCE_STATUSES) out[s] = Number(r[s] ?? 0);
  out.breaks_today = out.igual + out.alterado + out.novo;
  if (r.previous_date == null) {
    // Sem dia anterior: nada a comparar (não é "100% novo").
    for (const s of PERSISTENCE_STATUSES) out[s] = null;
    out.pct_igual = out.pct_alterado = out.pct_novo = null;
    return out;
  }
  out.breaks_previous = out.igual + out.alterado + out.resolvido;
  out.pct_igual = pct(out.igual, out.breaks_today);
  out.pct_alterado = pct(out.alterado, out.breaks_today);
  out.pct_novo = pct(out.novo, out.breaks_today);
  return out;
}

function compileDataQuality(metric, req) {
  const filters = req.filters ?? [];
  checkRequired(metric, filters);
  const conditions = filters.map((f) => renderFilter(f, ['business_date']));
  const where = whereClause(conditions);
  const limit = resolveLimit(metric, req.limit);
  const valuePair = `COALESCE(bnpp_value, '<NULL>') || '|' || COALESCE(cpty_value, '<NULL>')`;

  const sql = `SELECT
  r.business_date,
  r.raw_rows,
  COALESCE(d.distinct_breaks, 0) AS distinct_breaks,
  COALESCE(d.distinct_positions, 0) AS distinct_positions,
  COALESCE(c.conflicting_keys, 0) AS conflicting_keys
FROM (
  SELECT business_date, COUNT(*) AS raw_rows FROM breaks_raw
  ${where}
  GROUP BY business_date
) r
LEFT JOIN (
  SELECT business_date, COUNT(*) AS distinct_breaks, COUNT(DISTINCT ${positionKeyExpr()}) AS distinct_positions
  FROM breaks
  ${where}
  GROUP BY business_date
) d ON d.business_date = r.business_date
LEFT JOIN (
  SELECT business_date, COUNT(*) AS conflicting_keys
  FROM (
    SELECT business_date FROM breaks_raw
    ${where}
    GROUP BY business_date, uti, cp1_lei, cp2_lei, breaking_field
    HAVING COUNT(DISTINCT ${valuePair}) > 1
  ) k
  GROUP BY business_date
) c ON c.business_date = r.business_date
ORDER BY r.business_date
LIMIT ${limit}`;

  return {
    sql,
    postprocess: (rows) =>
      rows.map((r) => ({
        ...r,
        dup_factor:
          Number(r.distinct_breaks) > 0 ? Math.round((Number(r.raw_rows) / Number(r.distinct_breaks)) * 100) / 100 : null,
      })),
  };
}

const CUSTOM = { breaks_dod: compileDod, persistence: compilePersistence, data_quality: compileDataQuality };

/**
 * Compila um pedido. Devolve { metric, title, sql, postprocess }.
 * @param opts.excludedDates  business dates a saltar nas comparações entre dias (config.excludedDates)
 */
export function compileMetric(request, opts = {}) {
  if (!request || typeof request !== 'object') throw new ValidationError('Pedido inválido');
  const metric = getMetric(request.metric);
  if (request.filters !== undefined && !Array.isArray(request.filters)) {
    throw new ValidationError('"filters" tem de ser uma lista');
  }
  if (request.dimensions !== undefined && !Array.isArray(request.dimensions)) {
    throw new ValidationError('"dimensions" tem de ser uma lista');
  }
  const compiled =
    metric.kind === 'aggregate' ? compileAggregate(request.metric, metric, request) : CUSTOM[request.metric](metric, request, opts);
  return { metric: request.metric, title: metric.title, ...compiled };
}
