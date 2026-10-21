// Human-readable text of a rule (compile.js DSL), to show the operations user the format/condition error
// the value violates. Generated from the translation (the Excel text is not copied), in English like the ESMA document.
import { DATE_RE, TIMESTAMP_RE } from './compile.js';

/** Known formats (DSL regex -> description). */
const FORMATS = {
  '[A-Z]{3}': '3 alphabetic characters (ISO 4217 currency code)',
  '[A-Z]{3}/[A-Z]{3}': 'two ISO 4217 currency codes separated by "/" (7 characters)',
  '[A-Z0-9]{12}': '12 alphanumeric characters',
  '[A-Z0-9]{4}': '4 alphanumeric characters (MIC)',
  '[A-Z]{6}': '6 alphabetic characters (CFI)',
  '[A-WYZ]{2}[A-Z]{4}': 'CFI whose first 2 characters are not "X"',
  '[A-Z]{2}[A-Z0-9]{9}[0-9]': 'ISIN: 2 letters + 9 alphanumeric + 1 check digit (12 characters)',
  '[A-Z0-9]{18}[0-9]{2}': 'LEI: 20 alphanumeric characters',
  '[A-Z0-9-]{16}': 'EIC code: 16 alphanumeric characters',
  '([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z': 'time hh:mm:ssZ',
  '[A-Za-z0-9]{1,72}': 'up to 72 alphanumeric characters',
  '[A-Za-z0-9]([A-Za-z0-9:._-]{0,50}[A-Za-z0-9])?': 'up to 52 alphanumeric characters (":", ".", "-", "_" allowed, not at the start or end)',
  '[A-Z]{2}|[A-Z]{2}-[A-Z0-9]{1,3}|[A-Z0-9]{18}[0-9]{2}': 'ISO 3166 country code, ISO 3166-2 subdivision code or LEI',
};

const list = (vs) => vs.map((v) => `'${v}'`).join(', ');

function fieldName(ref, fieldMap) {
  if (ref === 'self') return 'this field';
  if (String(ref).startsWith('common:')) return String(ref).slice(7);
  const e = fieldMap.items[ref];
  return e ? `${e.field} (${ref})` : ref;
}

export function describePredicate(p, fieldMap) {
  const [op] = Object.keys(p);
  const a = p[op];
  const f = (r) => fieldName(r, fieldMap);
  switch (op) {
    case 'all': return a.map((x) => describePredicate(x, fieldMap)).join(' and ');
    case 'any': return `(${a.map((x) => describePredicate(x, fieldMap)).join(' or ')})`;
    case 'not': return `not (${describePredicate(a, fieldMap)})`;
    case 'populated': return `${f(a)} is populated`;
    case 'blank': return `${f(a)} is blank`;
    case 'eq': return `${f(a[0])} = '${a[1]}'`;
    case 'ne': return `${f(a[0])} ≠ '${a[1]}'`;
    case 'in': return `${f(a[0])} is one of ${list(a[1])}`;
    case 'not_in': return `${f(a[0])} is not one of ${list(a[1])}`;
    default: return JSON.stringify(p);
  }
}

export function describeCheck(check, fieldMap) {
  const [kind] = Object.keys(check);
  const s = check[kind];
  const f = (r) => fieldName(r, fieldMap);
  switch (kind) {
    case 'all': return s.map((c) => describeCheck(c, fieldMap)).join('; ');
    case 'if': {
      const then = describeCheck(s.then, fieldMap);
      const other = s.else ? `; otherwise ${describeCheck(s.else, fieldMap)}` : '';
      return `if ${describePredicate(s.when, fieldMap)}, ${then}${other}`;
    }
    case 'required': return 'this field shall be populated';
    case 'blank': return 'this field shall be left blank';
    case 'enum': return `this field shall contain one of ${list(s)}`;
    case 'not_in': return `the values ${list(s)} are not allowed`;
    case 'regex': return `format: ${FORMATS[s] ?? s}`;
    case 'date': return 'format: date YYYY-MM-DD';
    case 'timestamp': return 'format: timestamp YYYY-MM-DDThh:mm:ssZ';
    case 'year': return 'format: year YYYY starting with 19 or 20';
    case 'decimal': {
      const sign = { any: 'positive or negative', nonneg: 'greater than or equal to zero', positive: 'greater than zero' }[s.sign ?? 'any'];
      const dec = s.decimals ? ` including up to ${s.decimals} decimal places` : ' (integer)';
      const allow = s.allow?.length ? `; default ${list(s.allow)} accepted` : '';
      return `format: value ${sign}, up to ${s.digits} numeric characters${dec}${allow}`;
    }
    case 'compare': {
      const other = s.ref ? f(s.ref) : `'${s.value}'`;
      const what = { date: 'the date', timestamp: 'the timestamp', number: 'the value' }[s.as] ?? 'the value';
      return `${what} shall be ${s.op} ${other}`;
    }
    case 'count_populated': {
      const fs = s.refs.map(f).join(', ');
      if (s.min != null && s.max != null) return `between ${s.min} and ${s.max} of ${fs} shall be populated`;
      if (s.min != null) return `at least ${s.min} of ${fs} shall be populated`;
      return `at most ${s.max} of ${fs} shall be populated`;
    }
    case 'equals_any': return `this field shall be equal to ${s.map(f).join(' or ')}`;
    case 'not_equal': return `this field shall be different from ${f(s.ref)}${s.unless ? ` unless equal to ${f(s.unless)}` : ''}`;
    default: return JSON.stringify(check);
  }
}

/** Error message of a rule: condition (when) + what must hold. */
export function describeRule(rule, fieldMap) {
  if (rule.status === 'not_verifiable') return `not verifiable: ${rule.note}`;
  const body = describeCheck(rule.check, fieldMap);
  const text = rule.when ? `If ${describePredicate(rule.when, fieldMap)}: ${body}` : body.charAt(0).toUpperCase() + body.slice(1);
  return text;
}

/** ESMA field name of a TP suffix ("2.22 Valuation currency"); the suffix itself when it is not in the map. */
export function fieldLabel(suffix, fieldMap) {
  const s = String(suffix ?? '').toUpperCase();
  for (const [item, e] of Object.entries(fieldMap.items)) {
    if ((e.tp ?? []).some((t) => t.toUpperCase() === s)) return `${item} ${e.field}`;
  }
  return s;
}

export { DATE_RE, TIMESTAMP_RE };
