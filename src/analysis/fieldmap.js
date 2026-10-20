// Mapeamento BREAKING_FIELD (data mart) -> par de colunas TP1_<sufixo> / TP2_<sufixo> (ficheiro DTCC),
// e validação empírica: para o sufixo certo, os breaks têm TP1 ≠ TP2 e as transações sem break têm TP1 = TP2.
// Só produz nomes de colunas e contagens (nunca valores).
import { dateLiteral, stringLiteral } from '../semantic/literals.js';
import { POSITION_KEY } from '../db/model.js';

/** Nome normalizado para comparação: maiúsculas, só letras e dígitos. */
export const normalizeName = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const tokens = (s) => String(s).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);

/**
 * Pares TP1_/TP2_ a partir dos nomes das colunas do ficheiro DTCC.
 * @returns {{ suffix: string, tp1: string, tp2: string }[]}
 */
export function tpPairs(columnNames) {
  const tp2 = new Map(columnNames.filter((c) => /^TP2_/i.test(c)).map((c) => [c.slice(4).toUpperCase(), c]));
  return columnNames
    .filter((c) => /^TP1_/i.test(c) && tp2.has(c.slice(4).toUpperCase()))
    .map((c) => ({ suffix: c.slice(4), tp1: c, tp2: tp2.get(c.slice(4).toUpperCase()) }));
}

/** Semelhança entre nomes (0..1): tokens em comum + bónus se um nome normalizado contém o outro. */
export function similarity(a, b) {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size || 1;
  const na = normalizeName(a);
  const nb = normalizeName(b);
  const contains = na && nb && (na.includes(nb) || nb.includes(na)) ? 0.5 : 0;
  return Math.min(1, inter / union + contains);
}

/**
 * Liga cada campo a um par TP. Ordem: override explícito > nome igual (normalizado) > sem mapeamento
 * (com até 3 candidatos por semelhança, para decisão humana — nunca escolhidos automaticamente).
 * @param fields  nomes de BREAKING_FIELD
 * @param pairs   resultado de tpPairs()
 * @param overrides  { CAMPO: 'SUFIXO' }
 */
export function matchFields(fields, pairs, overrides = {}) {
  const bySuffix = new Map(pairs.map((p) => [normalizeName(p.suffix), p]));
  const ov = new Map(Object.entries(overrides).map(([k, v]) => [normalizeName(k), normalizeName(v)]));
  return fields.map((field) => {
    const n = normalizeName(field);
    if (ov.has(n)) {
      const pair = bySuffix.get(ov.get(n));
      if (!pair) throw new Error(`Override inválido: ${field} -> ${overrides[field] ?? ov.get(n)} (sufixo não existe no ficheiro DTCC)`);
      return { field, pair, how: 'override', candidates: [] };
    }
    if (bySuffix.has(n)) return { field, pair: bySuffix.get(n), how: 'nome igual', candidates: [] };
    const candidates = pairs
      .map((p) => ({ suffix: p.suffix, score: similarity(field, p.suffix) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score || a.suffix.localeCompare(b.suffix))
      .slice(0, 3)
      .map((c) => c.suffix);
    return { field, pair: null, how: null, candidates };
  });
}

const quoteIdent = (name) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Nome de coluna inválido: ${name}`);
  return `"${name}"`;
};

/**
 * SELECT do ficheiro DTCC para UMA business date, só com a chave (nomes lógicos, normalizada como no data mart)
 * e os pares TP pedidos (tp1_0, tp2_0, tp1_1, ...). As colunas físicas da chave são as mesmas do data mart.
 */
export function dtccSelectSql(config, dialect, fromSql, date, pairs) {
  const d = dateLiteral(date);
  const cols = config.columns;
  const key = POSITION_KEY.map((logical) => {
    const physical = cols[logical];
    if (!physical) throw new Error(`Falta o mapeamento da coluna "${logical}" (necessária para ligar ao ficheiro DTCC)`);
    return `NULLIF(TRIM(${dialect.castText(quoteIdent(physical))}), '') AS ${logical}`;
  });
  const tps = pairs.flatMap((p, i) => [
    `${dialect.castText(quoteIdent(p.tp1))} AS tp1_${i}`,
    `${dialect.castText(quoteIdent(p.tp2))} AS tp2_${i}`,
  ]);
  const dateCol = dialect.castDate(quoteIdent(cols.business_date), null);
  return `SELECT\n  ${[...key, ...tps].join(',\n  ')}\nFROM ${fromSql}\nWHERE ${dateCol} = ${d}`;
}

/**
 * Matriz de confusão de um campo: breaks do data mart (business date + campo) vs. TP1 ≠ TP2 no ficheiro DTCC.
 * `dtccTable` tem a chave lógica + tp1_<i>/tp2_<i> (ver dtccSelectSql). SQL standard.
 * Diferente = valores diferentes, ou só um dos lados NULL.
 */
export function confusionSql(date, field, i, dtccTable = 'dtcc') {
  const d = dateLiteral(date);
  const f = stringLiteral(String(field).toUpperCase());
  const keyCols = POSITION_KEY.join(', ');
  const on = POSITION_KEY.map((k) => `COALESCE(t.${k}, '') = COALESCE(b.${k}, '')`).join('\n    AND ');
  const a = `t.tp1_${i}`;
  const c = `t.tp2_${i}`;
  return `WITH b AS (
  SELECT DISTINCT ${keyCols}, 1 AS present
  FROM breaks
  WHERE business_date = ${d} AND UPPER(breaking_field) = ${f}
),
j AS (
  SELECT
    b.present,
    CASE WHEN (${a} = ${c}) OR (${a} IS NULL AND ${c} IS NULL) THEN 0 ELSE 1 END AS is_diff
  FROM ${dtccTable} t
  LEFT JOIN b
    ON ${on}
)
SELECT
  (SELECT COUNT(*) FROM b) AS n_breaks,
  SUM(CASE WHEN present = 1 THEN 1 ELSE 0 END) AS breaks_found,
  SUM(CASE WHEN present = 1 AND is_diff = 1 THEN 1 ELSE 0 END) AS break_diff,
  SUM(CASE WHEN present = 1 AND is_diff = 0 THEN 1 ELSE 0 END) AS break_equal,
  SUM(CASE WHEN present IS NULL AND is_diff = 1 THEN 1 ELSE 0 END) AS nobreak_diff,
  SUM(CASE WHEN present IS NULL AND is_diff = 0 THEN 1 ELSE 0 END) AS nobreak_equal
FROM j`;
}

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

/** Acrescenta percentagens à linha da matriz de confusão. */
export function confusionRow(r) {
  const n = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v ?? 0)]));
  return {
    ...n,
    pct_found: pct(n.breaks_found, n.n_breaks),
    pct_break_diff: pct(n.break_diff, n.breaks_found),
    pct_nobreak_diff: pct(n.nobreak_diff, n.nobreak_diff + n.nobreak_equal),
  };
}
