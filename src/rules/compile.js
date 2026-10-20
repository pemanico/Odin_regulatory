// Motor de regras EMIR (validation rules ESMA), avaliadas separadamente para cada lado de um break.
//
// Configuração (config/rules/):
//   field-map.json  item ESMA ("2.47") -> sufixo(s) TP do ficheiro DTCC, ou coluna comum (UTI, REFERENCE_DATE...)
//   emir-vr.json    uma entrada por código VR (DSL declarativa, ver docs abaixo)
//
// Lados: BNPP = TP1_<sufixo>; contraparte = TP2_<sufixo>. Cada lado é avaliado só com os SEUS campos;
// colunas comuns valem para os dois lados.
//
// DSL de uma regra:
//   { code, item, column?, when?, check, status, nota }
//   item     item ESMA alvo (o campo validado); column = sufixo TP se o item tiver mais de um
//   when     condição (opcional) sobre campos do mesmo lado:
//              {eq:[ref,v]} {ne:[ref,v]} {in:[ref,[...]]} {not_in:[ref,[...]]} {populated:ref} {blank:ref}
//              {all:[...]} {any:[...]} {not:{...}}
//            ref = item ESMA ("2.47"), "self" (o campo alvo) ou "common:<COLUNA>"
//   check    o que tem de ser verdade (se `when` for verdadeiro); violação = when ∧ ¬check
//              {required:true}  {blank:true}  {enum:[...]}  {not_in:[...]}  {regex:"..."}
//              {date:true}  {timestamp:true}  {year:true}
//              {decimal:{digits, decimals, sign:"any"|"nonneg"|"positive", allow?:[valores aceites]}}
//              {compare:{op, ref | value, as:"date"|"timestamp"|"number"}}  (só se os dois valores forem válidos)
//              {count_populated:{refs:[...], min?, max?}}
//              {all:[check, check, ...]}  (todos têm de ser cumpridos)
//              {if:{when:predicado, then:check, else?:check}}  ("se X então Y, senão Z"; sem else = cumpre)
//              {equals_any:[ref, ...]}  (valor igual a um dos campos referidos; só se preenchido)
//              {not_equal:{ref, unless?:ref}}  (valor diferente do campo ref, exceto se igual a `unless`)
//            Verificações de valor (enum, regex, decimal, ...) só se aplicam a valores preenchidos.
//   status   "verificavel" | "parcial" (só parte da regra é verificável; nota diz qual) | "nao_verificavel"
//
// Resultado da compilação: expressão SQL booleana "viola" para um lado, ou { notVerifiable: motivo }.
import { ValidationError } from '../semantic/literals.js';

export const SIDES = { BNPP: 'TP1', CPTY: 'TP2' };
const CHECKS = ['all', 'if', 'equals_any', 'not_equal', 'required', 'blank', 'enum', 'not_in', 'regex', 'date', 'timestamp', 'year', 'decimal', 'compare', 'count_populated'];
const STATUSES = ['verificavel', 'parcial', 'nao_verificavel'];

export const DATE_RE = '[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])';
export const TIMESTAMP_RE = `${DATE_RE}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z`;

const sqlString = (v) => `'${String(v).replace(/'/g, "''")}'`;
const quoteIdent = (name) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ValidationError(`Nome de coluna inválido: ${name}`);
  return `"${name}"`;
};

class NotVerifiable extends Error {}

/** Tipos numéricos do Parquet/DuckDB (verificação de decimal passa a sinal + grandeza). */
const NUMERIC_TYPE = /^(DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC|BIGINT|INTEGER|INT|SMALLINT|TINYINT|HUGEINT|UBIGINT|UINTEGER)/;

/** Valida a estrutura do ficheiro de regras (falha cedo, com o código da regra). */
export function validateRules(rulesDoc, fieldMap) {
  const seen = new Set();
  for (const r of rulesDoc.rules ?? []) {
    const where = r.code ?? JSON.stringify(r).slice(0, 60);
    if (!/^EMIR-VR-\d{4}-\d{2}$/.test(r.code ?? '')) throw new ValidationError(`Regra com código inválido: ${where}`);
    if (seen.has(r.code)) throw new ValidationError(`Código repetido: ${r.code}`);
    seen.add(r.code);
    if (!fieldMap.items[r.item]) throw new ValidationError(`${r.code}: item desconhecido ${r.item}`);
    if (!STATUSES.includes(r.status)) throw new ValidationError(`${r.code}: status inválido ${r.status}`);
    if (r.status !== 'nao_verificavel') {
      const keys = Object.keys(r.check ?? {});
      if (keys.length !== 1 || !CHECKS.includes(keys[0])) throw new ValidationError(`${r.code}: check inválido ${JSON.stringify(r.check)}`);
    }
    if (r.status !== 'verificavel' && !r.nota) throw new ValidationError(`${r.code}: regra ${r.status} precisa de nota`);
  }
  return rulesDoc;
}

/** Sufixo TP do campo alvo de uma regra. */
export function targetSuffix(rule, fieldMap) {
  const e = fieldMap.items[rule.item];
  const tps = e?.tp ?? [];
  if (rule.column) {
    if (!tps.includes(rule.column)) throw new ValidationError(`${rule.code}: column ${rule.column} não pertence ao item ${rule.item}`);
    return rule.column;
  }
  if (tps.length === 1) return tps[0];
  if (tps.length > 1) throw new ValidationError(`${rule.code}: item ${rule.item} tem vários sufixos, indicar column`);
  return null;
}

/**
 * Contexto de compilação de um lado.
 * @param columns  Map nome físico (maiúsculas) -> tipo, das colunas existentes no ficheiro DTCC
 */
function sideContext(rule, side, fieldMap, columns, dialect) {
  const prefix = SIDES[side];
  const colName = (suffix) => {
    const want = `${prefix}_${suffix}`.toUpperCase();
    if (!columns.has(want)) throw new NotVerifiable(`coluna ${prefix}_${suffix} não existe no ficheiro DTCC`);
    return want;
  };
  const column = (ref) => {
    if (ref === 'self') {
      const s = targetSuffix(rule, fieldMap);
      if (!s) throw new NotVerifiable(`item ${rule.item} sem colunas no ficheiro DTCC`);
      return colName(s);
    }
    if (String(ref).startsWith('common:')) {
      const c = String(ref).slice(7).toUpperCase();
      if (!columns.has(c)) throw new NotVerifiable(`coluna ${c} não existe no ficheiro DTCC`);
      return c;
    }
    const e = fieldMap.items[ref];
    if (!e) throw new ValidationError(`${rule.code}: referência a item desconhecido ${ref}`);
    if (e.common) {
      if (!columns.has(e.common.toUpperCase())) throw new NotVerifiable(`coluna ${e.common} não existe no ficheiro DTCC`);
      return e.common.toUpperCase();
    }
    if (!e.tp?.length) throw new NotVerifiable(`depende do campo ${ref} (${e.field}), que não está no ficheiro DTCC`);
    return colName(e.tp[0]);
  };
  /** Valor normalizado (texto aparado; vazio = NULL). */
  const val = (ref) => `NULLIF(TRIM(${dialect.castText(quoteIdent(column(ref)))}), '')`;
  const typeOf = (ref) => columns.get(column(ref)) ?? 'VARCHAR';
  /** Coluna física sem conversão para texto (para verificações numéricas em colunas tipadas). */
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
    default: throw new ValidationError(`Predicado desconhecido: ${JSON.stringify(p)}`);
  }
}

/** Regex de um número decimal com limites de dígitos (o ponto e o sinal não contam). */
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

/** Expressão "o valor cumpre o check" (NULL tratado conforme o tipo de check). */
function compileCheck(check, ctx, dialect) {
  const [kind] = Object.keys(check);
  const spec = check[kind];
  const v = ctx.val('self');
  const textual = () => {
    const t = String(ctx.typeOf('self')).toUpperCase();
    if (!t.startsWith('VARCHAR') && t !== 'TEXT' && t !== 'STRING') {
      throw new NotVerifiable(`coluna tipada (${t}) no Parquet: o formato original do reporte não está disponível`);
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
        // Coluna numérica no Parquet: o formato (casas decimais, ponto) perdeu-se, mas o sinal e a grandeza
        // continuam verificáveis. Parte inteira com mais de `digits` dígitos viola qualquer formato permitido.
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
      if (!ops.includes(spec.op)) throw new ValidationError(`compare: operador inválido ${spec.op}`);
      const other = spec.ref ? ctx.val(spec.ref) : sqlString(spec.value);
      let a = v;
      let b = other;
      let valid;
      if (spec.as === 'date') {
        // Compara a parte da data (YYYY-MM-DD) como texto: funciona para datas e timestamps ISO 8601.
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
        throw new ValidationError(`compare: "as" inválido ${spec.as}`);
      }
      // Sem os dois valores válidos não há comparação (as regras de formato tratam disso).
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
      throw new ValidationError(`Check desconhecido: ${kind}`);
  }
}

/**
 * Compila uma regra para um lado.
 * @returns {{ sql: string } | { notVerifiable: string }}  sql = expressão booleana "viola" (nunca NULL)
 */
export function compileRule(rule, side, { fieldMap, columns, dialect }) {
  if (rule.status === 'nao_verificavel') return { notVerifiable: rule.nota };
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

/** Compila todas as regras para os dois lados. */
export function compileAll(rulesDoc, ctx) {
  return rulesDoc.rules.map((rule) => {
    const out = { rule, suffix: targetSuffix(rule, ctx.fieldMap), sides: {} };
    for (const side of Object.keys(SIDES)) out.sides[side] = compileRule(rule, side, ctx);
    return out;
  });
}
