// EMIR rules engine (ESMA validation rules), evaluated separately for each side of a break.
//
// Configuration (config/rules/):
//   field-map.json  ESMA item ("2.47") -> TP suffix(es) in the DTCC file, or a common column (UTI, REFERENCE_DATE...)
//   emir-vr.json    one entry per VR code (declarative DSL, see below)
//
// Sides: BNPP = TP1_<suffix>; counterparty = TP2_<suffix>. Each side is evaluated with ITS OWN fields only;
// common columns apply to both sides.
//
// Rule DSL:
//   { code, item, column?, when?, check, status, note }
//   item     target ESMA item (the validated field); column = TP suffix when the item has more than one
//   when     optional condition on fields of the same side:
//              {eq:[ref,v]} {ne:[ref,v]} {in:[ref,[...]]} {not_in:[ref,[...]]} {populated:ref} {blank:ref}
//              {all:[...]} {any:[...]} {not:{...}}
//            ref = ESMA item ("2.47"), "self" (the target field) or "common:<COLUMN>"
//   check    what must hold (when `when` is true); violation = when ∧ ¬check
//              {required:true}  {blank:true}  {enum:[...]}  {not_in:[...]}  {regex:"..."}
//              {date:true}  {timestamp:true}  {year:true}
//              {decimal:{digits, decimals, sign:"any"|"nonneg"|"positive", allow?:[accepted values]}}
//              {compare:{op, ref | value, as:"date"|"timestamp"|"number"}}  (only when both values are valid)
//              {count_populated:{refs:[...], min?, max?}}
//              {all:[check, check, ...]}  (all must hold)
//              {if:{when:predicate, then:check, else?:check}}  ("if X then Y, else Z"; no else = passes)
//              {equals_any:[ref, ...]}  (value equals one of the referenced fields; only when populated)
//              {not_equal:{ref, unless?:ref}}  (value differs from field ref, unless it equals `unless`)
//            Value checks (enum, regex, decimal, ...) only apply to populated values.
//   status   "verifiable" | "partial" (only part of the rule can be verified; the note says which) | "not_verifiable"
//
// Compilation result: a boolean SQL expression "violates" for one side, or { notVerifiable: reason }.
import { ValidationError } from '../semantic/literals.js';

export const SIDES = { BNPP: 'TP1', CPTY: 'TP2' };
const CHECKS = ['all', 'if', 'equals_any', 'not_equal', 'required', 'blank', 'enum', 'not_in', 'regex', 'date', 'timestamp', 'year', 'decimal', 'compare', 'count_populated'];
export const STATUSES = ['verifiable', 'partial', 'not_verifiable'];

export const DATE_RE = '[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])';
export const TIMESTAMP_RE = `${DATE_RE}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z`;

const sqlString = (v) => `'${String(v).replace(/'/g, "''")}'`;
const quoteIdent = (name) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ValidationError(`Invalid column name: ${name}`);
  return `"${name}"`;
};

class NotVerifiable extends Error {}

/** Parquet/DuckDB numeric types (the decimal check becomes sign + magnitude). */
const NUMERIC_TYPE = /^(DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC|BIGINT|INTEGER|INT|SMALLINT|TINYINT|HUGEINT|UBIGINT|UINTEGER)/;

/** Validates the rules file structure (fails early, with the rule code). */
export function validateRules(rulesDoc, fieldMap) {
  const seen = new Set();
  for (const r of rulesDoc.rules ?? []) {
    const where = r.code ?? JSON.stringify(r).slice(0, 60);
    if (!/^EMIR-VR-\d{4}-\d{2}$/.test(r.code ?? '')) throw new ValidationError(`Rule with an invalid code: ${where}`);
    if (seen.has(r.code)) throw new ValidationError(`Duplicate code: ${r.code}`);
    seen.add(r.code);
    if (!fieldMap.items[r.item]) throw new ValidationError(`${r.code}: unknown item ${r.item}`);
    // Only fields with TP1_/TP2_ pairs in the DTCC file are validated (decision 2026-10-20).
    if (!fieldMap.items[r.item].tp?.length) {
      throw new ValidationError(`${r.code}: item ${r.item} has no TP1_/TP2_ columns in the DTCC file (only those fields are validated)`);
    }
    if (!STATUSES.includes(r.status)) throw new ValidationError(`${r.code}: invalid status ${r.status}`);
    if (r.status !== 'not_verifiable') {
      const keys = Object.keys(r.check ?? {});
      if (keys.length !== 1 || !CHECKS.includes(keys[0])) throw new ValidationError(`${r.code}: invalid check ${JSON.stringify(r.check)}`);
    }
    if (r.status !== 'verifiable' && !r.note) throw new ValidationError(`${r.code}: a ${r.status} rule needs a note`);
  }
  return rulesDoc;
}

/** TP suffix of a rule's target field. */
export function targetSuffix(rule, fieldMap) {
  const e = fieldMap.items[rule.item];
  const tps = e?.tp ?? [];
  if (rule.column) {
    if (!tps.includes(rule.column)) throw new ValidationError(`${rule.code}: column ${rule.column} does not belong to item ${rule.item}`);
    return rule.column;
  }
  if (tps.length === 1) return tps[0];
  if (tps.length > 1) throw new ValidationError(`${rule.code}: item ${rule.item} has several suffixes, set column`);
  return null;
}

/**
 * Compilation context for one side.
 * @param columns  Map physical name (upper case) -> type, of the columns present in the DTCC file
 */
function sideContext(rule, side, fieldMap, columns, dialect) {
  const prefix = SIDES[side];
  const colName = (suffix) => {
    const want = `${prefix}_${suffix}`.toUpperCase();
    if (!columns.has(want)) throw new NotVerifiable(`column ${prefix}_${suffix} does not exist in the DTCC file`);
    return want;
  };
  const column = (ref) => {
    if (ref === 'self') {
      const s = targetSuffix(rule, fieldMap);
      if (!s) throw new NotVerifiable(`item ${rule.item} has no columns in the DTCC file`);
      return colName(s);
    }
    // TP1_/TP2_ fields only (decision 2026-10-20): references to common columns (UTI, LEIs, REFERENCE_DATE) are not used.
    if (String(ref).startsWith('common:')) {
      throw new NotVerifiable(`compares with the common column ${String(ref).slice(7)} (no TP1_/TP2_)`);
    }
    const e = fieldMap.items[ref];
    if (!e) throw new ValidationError(`${rule.code}: reference to unknown item ${ref}`);
    if (e.common) throw new NotVerifiable(`compares with ${ref} (${e.field}), a common column without TP1_/TP2_`);
    if (!e.tp?.length) throw new NotVerifiable(`depends on field ${ref} (${e.field}), which is not in the DTCC file`);
    return colName(e.tp[0]);
  };
  /** Normalised value (trimmed text; empty = NULL). */
  const val = (ref) => `NULLIF(TRIM(${dialect.castText(quoteIdent(column(ref)))}), '')`;
  const typeOf = (ref) => columns.get(column(ref)) ?? 'VARCHAR';
  /** Physical column without a text cast (for numeric checks on typed columns). */
  const raw = (ref) => quoteIdent(column(ref));
  return { val, typeOf, raw };
}

function compilePredicate(p, ctx) {
  const [op] = Object.keys(p ?? {});
  const a = p[op];
  switch (op) {
    case 'all': return `(${a.map((x) => compilePredicate(x, ctx)).join(' AND ')})`;
    case 'any': return `(${a.map((x) => compilePredicate(x, ctx)).join(' OR ')})`;
    case 'not': return `NOT COALESCE(${compilePredicate(a, ctx)}, FALSE)`;
    case 'populated': return `(${ctx.val(a)} IS NOT NULL)`;
    case 'blank': return `(${ctx.val(a)} IS NULL)`;
    case 'eq': return `COALESCE(${ctx.val(a[0])} = ${sqlString(a[1])}, FALSE)`;
    case 'ne': return `COALESCE(${ctx.val(a[0])} <> ${sqlString(a[1])}, FALSE)`;
    case 'in': return `COALESCE(${ctx.val(a[0])} IN (${a[1].map(sqlString).join(', ')}), FALSE)`;
    case 'not_in': return `COALESCE(${ctx.val(a[0])} NOT IN (${a[1].map(sqlString).join(', ')}), FALSE)`;
    default: throw new ValidationError(`Unknown predicate: ${JSON.stringify(p)}`);
  }
}

/** Regex for a decimal number with digit limits (the point and the sign do not count). */
function decimalOk(v, spec, dialect) {
  const { digits, decimals = 0, sign = 'any', allow = [] } = spec;
  const signRe = sign === 'any' ? '-?' : '';
  const shape = decimals > 0 ? `${signRe}[0-9]+(\\.[0-9]{1,${decimals}})?` : `${signRe}[0-9]+`;
  const parts = [
    dialect.regexFull(v, shape),
    `LENGTH(REPLACE(REPLACE(${v}, '-', ''), '.', '')) <= ${Number(digits)}`,
  ];
  if (sign === 'positive') parts.push(`NOT ${dialect.regexFull(v, '0*(\\.0*)?')}`);
  const ok = `(${parts.join(' AND ')})`;
  return allow.length ? `(${ok} OR ${v} IN (${allow.map(sqlString).join(', ')}))` : ok;
}

/** Expression "the value passes the check" (NULL handled according to the check type). */
function compileCheck(check, ctx, dialect) {
  const [kind] = Object.keys(check);
  const spec = check[kind];
  const v = ctx.val('self');
  const textual = () => {
    const t = String(ctx.typeOf('self')).toUpperCase();
    if (!t.startsWith('VARCHAR') && t !== 'TEXT' && t !== 'STRING') {
      throw new NotVerifiable(`typed column (${t}) in the Parquet: the original reported format is not available`);
    }
  };
  const ifPopulated = (expr) => `(${v} IS NULL OR ${expr})`;
  switch (kind) {
    case 'all': return `(${spec.map((c) => `COALESCE(${compileCheck(c, ctx, dialect)}, FALSE)`).join(' AND ')})`;
    case 'if': {
      const cond = compilePredicate(spec.when, ctx);
      const then = `COALESCE(${compileCheck(spec.then, ctx, dialect)}, FALSE)`;
      const other = spec.else ? `COALESCE(${compileCheck(spec.else, ctx, dialect)}, FALSE)` : 'TRUE';
      return `(CASE WHEN ${cond} THEN ${then} ELSE ${other} END)`;
    }
    case 'equals_any': return ifPopulated(`(${spec.map((r) => `COALESCE(${v} = ${ctx.val(r)}, FALSE)`).join(' OR ')})`);
    case 'not_equal': {
      const other = ctx.val(spec.ref);
      const unless = spec.unless ? ` OR COALESCE(${v} = ${ctx.val(spec.unless)}, FALSE)` : '';
      return `(${v} IS NULL OR ${other} IS NULL OR ${v} <> ${other}${unless})`;
    }
    case 'required': return `(${v} IS NOT NULL)`;
    case 'blank': return `(${v} IS NULL)`;
    case 'enum': return ifPopulated(`${v} IN (${spec.map(sqlString).join(', ')})`);
    case 'not_in': return ifPopulated(`${v} NOT IN (${spec.map(sqlString).join(', ')})`);
    case 'regex': textual(); return ifPopulated(dialect.regexFull(v, spec));
    case 'date': textual(); return ifPopulated(dialect.regexFull(v, DATE_RE));
    case 'timestamp': textual(); return ifPopulated(dialect.regexFull(v, TIMESTAMP_RE));
    case 'year': textual(); return ifPopulated(dialect.regexFull(v, '(19|20)[0-9]{2}'));
    case 'decimal': {
      const t = String(ctx.typeOf('self')).toUpperCase();
      if (NUMERIC_TYPE.test(t)) {
        // Numeric column in the Parquet: the format (decimal places, point) is lost, but sign and magnitude
        // can still be verified. An integer part with more than `digits` digits violates any allowed format.
        const x = ctx.raw('self');
        const parts = [`ABS(${x}) < 1e${Number(spec.digits)}`];
        if (spec.sign === 'nonneg') parts.push(`${x} >= 0`);
        if (spec.sign === 'positive') parts.push(`${x} > 0`);
        const allow = (spec.allow ?? []).map((a) => `${x} = ${Number(a)}`);
        const ok = `(${parts.join(' AND ')})`;
        return `(${x} IS NULL OR ${allow.length ? `(${ok} OR ${allow.join(' OR ')})` : ok})`;
      }
      textual();
      return ifPopulated(decimalOk(v, spec, dialect));
    }
    case 'compare': {
      const ops = ['>=', '<=', '>', '<', '='];
      if (!ops.includes(spec.op)) throw new ValidationError(`compare: invalid operator ${spec.op}`);
      const other = spec.ref ? ctx.val(spec.ref) : sqlString(spec.value);
      let a = v;
      let b = other;
      let valid;
      if (spec.as === 'date') {
        // Compares the date part (YYYY-MM-DD) as text: works for ISO 8601 dates and timestamps.
        a = `SUBSTR(${v}, 1, 10)`;
        b = `SUBSTR(${other}, 1, 10)`;
        valid = `${dialect.regexFull(a, DATE_RE)} AND ${dialect.regexFull(b, DATE_RE)}`;
      } else if (spec.as === 'timestamp') {
        valid = `${dialect.regexFull(a, TIMESTAMP_RE)} AND ${dialect.regexFull(b, TIMESTAMP_RE)}`;
      } else if (spec.as === 'number') {
        const num = '-?[0-9]+(\\.[0-9]+)?';
        valid = `${dialect.regexFull(a, num)} AND ${dialect.regexFull(b, num)}`;
        a = dialect.castNumber(a);
        b = dialect.castNumber(b);
      } else {
        throw new ValidationError(`compare: invalid "as" ${spec.as}`);
      }
      // Without two valid values there is no comparison (the format rules cover that).
      return `(NOT COALESCE(${valid}, FALSE) OR ${a} ${spec.op} ${b})`;
    }
    case 'count_populated': {
      const n = spec.refs.map((r) => `CASE WHEN ${ctx.val(r)} IS NOT NULL THEN 1 ELSE 0 END`).join(' + ');
      const parts = [];
      if (spec.min != null) parts.push(`(${n}) >= ${Number(spec.min)}`);
      if (spec.max != null) parts.push(`(${n}) <= ${Number(spec.max)}`);
      return `(${parts.join(' AND ')})`;
    }
    default:
      throw new ValidationError(`Unknown check: ${kind}`);
  }
}

/**
 * Compiles one rule for one side.
 * @returns {{ sql: string } | { notVerifiable: string }}  sql = boolean expression "violates" (never NULL)
 */
export function compileRule(rule, side, { fieldMap, columns, dialect }) {
  if (rule.status === 'not_verifiable') return { notVerifiable: rule.note };
  try {
    const ctx = sideContext(rule, side, fieldMap, columns, dialect);
    const ok = compileCheck(rule.check, ctx, dialect);
    const when = rule.when ? compilePredicate(rule.when, ctx) : 'TRUE';
    return { sql: `COALESCE(${when} AND NOT COALESCE(${ok}, FALSE), FALSE)` };
  } catch (err) {
    if (err instanceof NotVerifiable) return { notVerifiable: err.message };
    throw err;
  }
}

/** Compiles every rule for both sides. */
export function compileAll(rulesDoc, ctx) {
  return rulesDoc.rules.map((rule) => {
    const out = { rule, suffix: targetSuffix(rule, ctx.fieldMap), sides: {} };
    for (const side of Object.keys(SIDES)) out.sides[side] = compileRule(rule, side, ctx);
    return out;
  });
}
