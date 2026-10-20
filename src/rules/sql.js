// SQL do motor de regras: entrada (transações DTCC com break), resultados por regra e veredicto por break.
// Só SQL standard + funções do dialeto (regexFull, castNumber, stringAgg).
import { dateLiteral } from '../semantic/literals.js';
import { POSITION_KEY } from '../db/model.js';

const quoteIdent = (name) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Nome de coluna inválido: ${name}`);
  return `"${name}"`;
};
const sqlString = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** Colunas da chave na tabela de entrada: k_<lógica> (evita colisão com os nomes físicos, ex. UTI). */
export const K = POSITION_KEY.map((k) => `k_${k}`);

/** Chave normalizada a partir das colunas físicas (as mesmas no data mart e no ficheiro DTCC). */
export function keySelect(config, dialect) {
  return POSITION_KEY.map(
    (logical) => `NULLIF(TRIM(${dialect.castText(quoteIdent(config.columns[logical]))}), '') AS k_${logical}`,
  ).join(',\n  ');
}

/**
 * Transações do ficheiro DTCC de uma business date (por omissão só as que têm break no data mart),
 * com a chave normalizada e só as colunas que as regras usam (`columns`; vazio = todas).
 */
export function ruleInputSql(config, dialect, fromSql, date, { onlyBreaks = true, columns = [] } = {}) {
  const d = dateLiteral(date);
  const dateCol = dialect.castDate(quoteIdent(config.columns.business_date), null);
  const cols = columns.length ? columns.map((c) => `s.${quoteIdent(c)}`).join(', ') : 's.*';
  const base = `SELECT\n  ${keySelect(config, dialect)},\n  ${cols}\nFROM ${fromSql} s\nWHERE ${dateCol} = ${d}`;
  if (!onlyBreaks) return base;
  const on = POSITION_KEY.map((k) => `COALESCE(t.k_${k}, '') = COALESCE(p.${k}, '')`).join('\n  AND ');
  return `SELECT t.*
FROM (
${base}
) t
JOIN (SELECT DISTINCT ${POSITION_KEY.join(', ')} FROM breaks WHERE business_date = ${d}) p
  ON ${on}`;
}

export const RESULTS_DDL = `CREATE TABLE IF NOT EXISTS rule_results (
  business_date DATE,
  ${POSITION_KEY.map((k) => `${k} VARCHAR`).join(',\n  ')},
  item VARCHAR,
  target VARCHAR,
  side VARCHAR,
  code VARCHAR,
  rules_version VARCHAR
)`;

/** INSERT das violações de uma regra num lado. `violates` = expressão de compileRule. */
export function insertViolationsSql(date, c, side, violates, version, input = 'rule_input') {
  return `INSERT INTO rule_results
SELECT ${dateLiteral(date)}, ${K.join(', ')}, ${sqlString(c.rule.item)}, ${sqlString(String(c.suffix ?? '').toUpperCase())},
  ${sqlString(side)}, ${sqlString(c.rule.code)}, ${sqlString(version)}
FROM ${input}
WHERE ${violates}`;
}

export const VERDICT_DDL = `CREATE TABLE IF NOT EXISTS break_verdict (
  business_date DATE,
  ${POSITION_KEY.map((k) => `${k} VARCHAR`).join(',\n  ')},
  breaking_field VARCHAR,
  verifiable_rules INTEGER,
  bnpp_violations INTEGER,
  cpty_violations INTEGER,
  bnpp_codes VARCHAR,
  cpty_codes VARCHAR,
  verdict VARCHAR,
  rules_version VARCHAR
)`;

/** Veredictos possíveis (por ordem de leitura na UI). */
export const VERDICTS = ['so_bnpp', 'so_contraparte', 'ambos', 'divergencia', 'sem_regras_verificaveis'];
export const DIVERGENCE_MESSAGE =
  'Divergência: os dois valores cumprem as regras ESMA verificáveis; as regras não determinam o lado errado.';

/**
 * Veredicto por break da business date. `fieldRules` = tabela (target, n) com o nº de regras verificáveis por campo.
 * Um break cujo campo não tem regras verificáveis fica "sem_regras_verificaveis" (não é divergência).
 */
export function insertVerdictSql(date, dialect, version) {
  const d = dateLiteral(date);
  const on = POSITION_KEY.map((k) => `COALESCE(r.${k}, '') = COALESCE(b.${k}, '')`).join('\n    AND ');
  const codes = (side) =>
    dialect.stringAgg(`CASE WHEN r.side = '${side}' THEN r.code END`, ',', `CASE WHEN r.side = '${side}' THEN r.code END`);
  return `INSERT INTO break_verdict
SELECT
  ${d},
  ${POSITION_KEY.map((k) => `b.${k}`).join(', ')},
  b.field,
  COALESCE(MAX(f.n), 0),
  SUM(CASE WHEN r.side = 'BNPP' THEN 1 ELSE 0 END),
  SUM(CASE WHEN r.side = 'CPTY' THEN 1 ELSE 0 END),
  ${codes('BNPP')},
  ${codes('CPTY')},
  CASE
    WHEN COALESCE(MAX(f.n), 0) = 0 THEN 'sem_regras_verificaveis'
    WHEN SUM(CASE WHEN r.side = 'BNPP' THEN 1 ELSE 0 END) > 0 AND SUM(CASE WHEN r.side = 'CPTY' THEN 1 ELSE 0 END) > 0 THEN 'ambos'
    WHEN SUM(CASE WHEN r.side = 'BNPP' THEN 1 ELSE 0 END) > 0 THEN 'so_bnpp'
    WHEN SUM(CASE WHEN r.side = 'CPTY' THEN 1 ELSE 0 END) > 0 THEN 'so_contraparte'
    ELSE 'divergencia'
  END,
  ${sqlString(version)}
FROM (SELECT ${POSITION_KEY.join(', ')}, UPPER(breaking_field) AS field FROM breaks WHERE business_date = ${d}) b
LEFT JOIN field_rules f ON f.target = b.field
LEFT JOIN rule_results r
  ON r.business_date = ${d}
    AND r.target = b.field
    AND ${on}
GROUP BY ${POSITION_KEY.map((k) => `b.${k}`).join(', ')}, b.field`;
}

/** Tabela field_rules (target, n) a partir das regras compiladas (n = regras com SQL em pelo menos um lado). */
export function fieldRulesSql(compiled) {
  const counts = new Map();
  for (const c of compiled) {
    if (!c.suffix) continue;
    const t = c.suffix.toUpperCase();
    const ok = Object.values(c.sides).some((s) => s.sql);
    counts.set(t, (counts.get(t) ?? 0) + (ok ? 1 : 0));
  }
  const rows = [...counts.entries()].map(([t, n]) => `SELECT ${sqlString(t)} AS target, ${n} AS n`);
  const body = rows.length ? rows.join('\nUNION ALL ') : `SELECT CAST(NULL AS VARCHAR) AS target, 0 AS n WHERE 1 = 0`;
  return `CREATE TEMP TABLE field_rules AS ${body}`;
}

/** Colunas físicas usadas nas expressões compiladas (identificadores entre aspas). */
export function usedColumns(compiled) {
  const out = new Set();
  for (const c of compiled) {
    for (const s of Object.values(c.sides)) {
      for (const m of String(s.sql ?? '').matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)) out.add(m[1]);
    }
  }
  return [...out].sort();
}
