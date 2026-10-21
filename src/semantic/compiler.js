// Semantic layer compiler: structured request -> standard SQL.
// Request: { metric, dimensions?, filters?: [{ dimension, op, value }], limit? }
// Guarantees:
//  - identifiers only from the catalog (whitelist);
//  - values validated by type and escaped (literals.js);
//  - fixed grain and measure per metric: the same question always gives the same number.
import { METRICS, DIMENSIONS, FILTER_OPS } from './catalog.js';
import { ValidationError, literalFor, intValue, isValidDate } from './literals.js';
import { positionKeyExpr, BREAK_KEY } from '../db/model.js';
import { previousDateSql, assertNotExcluded } from './calendar.js';
import { KEY_VERDICTS } from '../rules/sql.js';

export class MetricUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MetricUnavailableError';
  }
}

const MAX_DIMENSIONS = 4;
/** Dimensions compared case-insensitively (field names vary between sources). */
const CASE_INSENSITIVE = ['breaking_field'];
const MAX_IN_VALUES = 100;

function getMetric(id) {
  const metric = METRICS[id];
  if (!metric) {
    throw new ValidationError(`Unknown metric: ${JSON.stringify(id)}. Available: ${Object.keys(METRICS).join(', ')}`);
  }
  if (metric.kind === 'pending') throw new MetricUnavailableError(`${metric.title}: unavailable. ${metric.pendingReason}`);
  return metric;
}

/** Renders a filter as an SQL condition. `allowed` = dimensions that can be filtered in this metric. */
export function renderFilter(filter, allowed) {
  const { dimension, op, value } = filter ?? {};
  const dim = DIMENSIONS[dimension];
  if (!dim || !allowed.includes(dimension)) {
    throw new ValidationError(`Filter not allowed in this metric: ${JSON.stringify(dimension)}`);
  }
  if (!FILTER_OPS.includes(op)) throw new ValidationError(`Invalid filter operator: ${JSON.stringify(op)}`);
  // breaking_field is lower case in the data mart and upper case in break_verdict: case-insensitive comparison.
  const ci = CASE_INSENSITIVE.includes(dimension);
  const col = ci ? `UPPER(${dimension})` : dimension;
  const lit = (v) => (ci ? literalFor(dim.type, String(v).toUpperCase()) : literalFor(dim.type, v));

  switch (op) {
    case 'eq':
      return `${col} = ${lit(value)}`;
    case 'gte':
      return `${col} >= ${lit(value)}`;
    case 'lte':
      return `${col} <= ${lit(value)}`;
    case 'in': {
      if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IN_VALUES) {
        throw new ValidationError(`"in" requires a list of 1 to ${MAX_IN_VALUES} values`);
      }
      return `${col} IN (${value.map(lit).join(', ')})`;
    }
    case 'between': {
      if (!Array.isArray(value) || value.length !== 2) throw new ValidationError('"between" requires [start, end]');
      const [a, b] = value;
      if (dim.type === 'date' && isValidDate(a) && isValidDate(b) && a > b) {
        throw new ValidationError(`Inverted date range: ${a} > ${b}`);
      }
      return `${col} BETWEEN ${lit(a)} AND ${lit(b)}`;
    }
    default:
      throw new ValidationError(`Unsupported operator: ${op}`);
  }
}

function checkRequired(metric, filters) {
  for (const req of metric.requiredFilters ?? []) {
    const f = filters.find((x) => x?.dimension === req);
    if (!f) throw new ValidationError(`Missing required filter: ${req}`);
    const ops = metric.requiredOps?.[req];
    if (ops && !ops.includes(f.op)) {
      throw new ValidationError(`The ${req} filter of this metric only accepts: ${ops.join(', ')}`);
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
  if (dims.length > MAX_DIMENSIONS) throw new ValidationError(`At most ${MAX_DIMENSIONS} dimensions`);
  for (const d of dims) {
    if (!metric.allowedDimensions.includes(d)) {
      throw new ValidationError(`Dimension not allowed in ${id}: ${JSON.stringify(d)}`);
    }
  }
  const filters = req.filters ?? [];
  checkRequired(metric, filters);
  const conditions = filters.map((f) => renderFilter(f, metric.allowedFilterDimensions ?? Object.keys(DIMENSIONS)));
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

/** NULL-safe and standard SQL (no IS NOT DISTINCT FROM, which not every engine accepts outside a JOIN). */
const sameValue = (a, b) => `(${a} = ${b} OR (${a} IS NULL AND ${b} IS NULL))`;
/** NULL-safe equality of the key columns (one of UTI or PROPRIETARY is always NULL). */
const sameKey = (a, b) => `COALESCE(${a}, '') = COALESCE(${b}, '')`;
/** Break key without the date (the production key). */
const PERSISTENCE_KEY = BREAK_KEY.filter((k) => k !== 'business_date');
const PERSISTENCE_STATUSES = ['same', 'changed', 'new', 'resolved'];

function compilePersistence(metric, req, opts) {
  const filters = req.filters ?? [];
  checkRequired(metric, filters);
  const dateFilter = filters.find((f) => f.dimension === 'business_date');
  const date = literalFor('date', dateFilter.value);
  assertNotExcluded(dateFilter.value, opts.excludedDates);

  const dims = [...new Set(req.dimensions ?? metric.defaultDimensions)];
  for (const d of dims) {
    if (!metric.allowedDimensions.includes(d)) {
      throw new ValidationError(`Dimension not allowed in persistence: ${JSON.stringify(d)}`);
    }
  }
  const others = filters.filter((f) => f.dimension !== 'business_date');
  const conditions = others.map((f) => renderFilter(f, metric.allowedFilterDimensions));
  const limit = resolveLimit(metric, req.limit);

  // Dimension columns needed (grouping + filters). The value of D wins; for resolved breaks, the value of D-1.
  const dimCols = [...new Set([...dims, ...others.map((f) => f.dimension)])].filter((d) => !PERSISTENCE_KEY.includes(d));
  const sideCols = [...PERSISTENCE_KEY, 'bnpp_value', 'cpty_value', ...dimCols].join(', ');
  const joinedDims = [...new Set([...dims, ...others.map((f) => f.dimension)])]
    .map((d) => `COALESCE(c.${d}, p.${d}) AS ${d}`)
    .join(',\n    ');
  const status = `CASE
      WHEN p.present IS NULL THEN 'new'
      WHEN c.present IS NULL THEN 'resolved'
      WHEN ${sameValue('c.bnpp_value', 'p.bnpp_value')} AND ${sameValue('c.cpty_value', 'p.cpty_value')} THEN 'same'
      ELSE 'changed'
    END`;
  const count = (s) => `SUM(CASE WHEN status = '${s}' THEN 1 ELSE 0 END) AS "${s}"`;
  const select = [
    ...dims,
    '(SELECT d FROM prev) AS previous_date',
    ...PERSISTENCE_STATUSES.map(count),
  ].join(',\n  ');
  const where = whereClause([`EXISTS (SELECT 1 FROM breaks WHERE business_date = ${date})`, ...conditions]);
  const groupBy = dims.length ? `\nGROUP BY ${dims.join(', ')}` : '';
  const todayCount = `SUM(CASE WHEN status IN ('same', 'changed', 'new') THEN 1 ELSE 0 END)`;
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
        // Without GROUP BY, an aggregate over zero rows returns one row of NULLs: drop it (date without data).
        .filter((r) => PERSISTENCE_STATUSES.some((s) => Number(r[s] ?? 0) > 0))
        .map(persistenceRow),
  };
}

const pct = (n, total) => (total > 0 ? Math.round((n / total) * 1000) / 10 : null);

/** Converts the counts, computes totals and percentages (over the breaks of D). */
function persistenceRow(r) {
  const out = { ...r };
  for (const s of PERSISTENCE_STATUSES) out[s] = Number(r[s] ?? 0);
  out.breaks_today = out.same + out.changed + out.new;
  if (r.previous_date == null) {
    // No previous day: nothing to compare (it is not "100% new").
    for (const s of PERSISTENCE_STATUSES) out[s] = null;
    out.pct_same = out.pct_changed = out.pct_new = null;
    return out;
  }
  out.breaks_previous = out.same + out.changed + out.resolved;
  out.pct_same = pct(out.same, out.breaks_today);
  out.pct_changed = pct(out.changed, out.breaks_today);
  out.pct_new = pct(out.new, out.breaks_today);
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
    GROUP BY ${BREAK_KEY.join(', ')}
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

/** Field name safe for LIKE (letters, digits and _ only; the _ is escaped). */
function fieldLikeLiteral(value) {
  const v = String(value ?? '').toUpperCase();
  if (!/^[A-Z0-9_]{1,100}$/.test(v)) throw new ValidationError(`Invalid field name: ${JSON.stringify(value)}`);
  return `'%|${v.replace(/_/g, '\\_')}|%' ESCAPE '\\'`;
}

/** `|A|B|` -> ['A', 'B'] */
export function comboFields(combo) {
  return String(combo ?? '').split('|').filter(Boolean);
}

function compileFieldCombinations(metric, req) {
  const filters = req.filters ?? [];
  checkRequired(metric, filters);
  const conditions = filters.map((f) => {
    if (f?.dimension === 'breaking_field') return `combo LIKE ${fieldLikeLiteral(f.value)}`;
    return renderFilter(f, metric.allowedFilterDimensions);
  });
  const limit = resolveLimit(metric, req.limit);
  const n = (v) => `SUM(CASE WHEN key_verdict = '${v}' THEN 1 ELSE 0 END) AS ${v}`;
  const sql = `SELECT combo, MAX(n_fields) AS n_fields, COUNT(*) AS n_keys,
  ${KEY_VERDICTS.map(n).join(',\n  ')}
FROM key_summary
${whereClause(conditions)}
GROUP BY combo
ORDER BY n_keys DESC, combo
LIMIT ${limit}`;
  return {
    sql,
    postprocess: (rows) =>
      rows.map((r) => ({ ...r, combo_key: r.combo, combo: comboFields(r.combo).join(' + ') })),
  };
}

const CUSTOM = {
  breaks_dod: compileDod,
  persistence: compilePersistence,
  data_quality: compileDataQuality,
  field_combinations: compileFieldCombinations,
};

/**
 * Compiles a request. Returns { metric, title, sql, postprocess }.
 * @param opts.excludedDates  business dates to skip in day-on-day comparisons (config.excludedDates)
 */
export function compileMetric(request, opts = {}) {
  if (!request || typeof request !== 'object') throw new ValidationError('Invalid request');
  const metric = getMetric(request.metric);
  if (request.filters !== undefined && !Array.isArray(request.filters)) {
    throw new ValidationError('"filters" must be a list');
  }
  if (request.dimensions !== undefined && !Array.isArray(request.dimensions)) {
    throw new ValidationError('"dimensions" must be a list');
  }
  const compiled =
    metric.kind === 'aggregate' ? compileAggregate(request.metric, metric, request) : CUSTOM[request.metric](metric, request, opts);
  return { metric: request.metric, title: metric.title, ...compiled };
}
