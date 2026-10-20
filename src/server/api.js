// Lógica da API, independente do framework HTTP (o Express em app.js é só o invólucro).
// Duas classes de operações (plano aprovado em 2026-10-20):
//  - tools do agente: só agregados (metrics, query) — as mesmas que o LLM vai usar;
//  - só UI: linhas (keys, key) — mostradas de forma determinística; nunca expostas ao agente.
// Todas registam auditoria sem dados (pedido, nº de linhas, duração).
import { describeCatalog } from '../semantic/catalog.js';
import { runMetric } from '../semantic/runner.js';
import { ValidationError, dateLiteral, stringLiteral, intValue, isValidDate } from '../semantic/literals.js';
import { MetricUnavailableError } from '../semantic/compiler.js';
import { POSITION_KEY } from '../db/model.js';
import { VERDICTS, KEY_VERDICTS } from '../rules/sql.js';
import { audit as defaultAudit } from '../audit.js';
import { AGENT_TOOLS } from './tools.js';
import { DbBusyError } from './dbpool.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../config.js';

/** Jurisdições do seletor: só EMIR ativa na demo. */
export const JURISDICTIONS = [
  { id: 'EMIR', label: 'EMIR', enabled: true },
  { id: 'MIFID', label: 'MiFID II', enabled: false },
  { id: 'CFTC', label: 'CFTC', enabled: false },
  { id: 'SFTR', label: 'SFTR', enabled: false },
];

const SORTS = {
  fields_desc: 'k.n_fields DESC, k.key_id',
  fields_asc: 'k.n_fields ASC, k.key_id',
  verdict: `CASE k.key_verdict WHEN 'misto' THEN 1 WHEN 'bnpp' THEN 2 WHEN 'contraparte' THEN 3 ELSE 4 END, k.n_fields DESC, k.key_id`,
  counterparty: 'k.cp2_lei, k.n_fields DESC, k.key_id',
};
const MAX_PAGE_SIZE = 200;
const COMBO_RE = /^\|([A-Z0-9_]+\|)+$/;
const sameKey = (a, b) => POSITION_KEY.map((k) => `COALESCE(${a}.${k}, '') = COALESCE(${b}.${k}, '')`).join(' AND ');

/** Código HTTP para cada tipo de erro. */
export function statusFor(err) {
  if (err instanceof ValidationError) return 400;
  if (err instanceof MetricUnavailableError) return 409;
  if (err instanceof DbBusyError) return 503;
  if (err?.name === 'NotFoundError') return 404;
  return 500;
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

const opt = (v) => (v === undefined || v === null || v === '' ? undefined : v);

/** Valida os parâmetros da lista de Keys e devolve as condições SQL (só literais validados). */
export function keysQuery(q) {
  if (!isValidDate(q.date)) throw new ValidationError('Parâmetro "date" obrigatório (YYYY-MM-DD)');
  const d = dateLiteral(q.date);
  const where = [`k.business_date = ${d}`];
  let join = '';
  const field = opt(q.field) && String(q.field).toUpperCase();
  if (field) {
    if (!/^[A-Z0-9_]{1,100}$/.test(field)) throw new ValidationError(`Campo inválido: ${JSON.stringify(q.field)}`);
    // Só Keys com break neste campo, com o veredicto do campo (para a coluna e o filtro field_verdict).
    join = `JOIN break_verdict bv ON bv.business_date = ${d} AND bv.breaking_field = ${stringLiteral(field)} AND ${sameKey('bv', 'k')}`;
  }
  if (opt(q.field_verdict)) {
    if (!field) throw new ValidationError('"field_verdict" exige "field"');
    if (!VERDICTS.includes(q.field_verdict)) throw new ValidationError(`Veredicto inválido: ${q.field_verdict}`);
    where.push(`bv.verdict = ${stringLiteral(q.field_verdict)}`);
  }
  if (opt(q.combo)) {
    if (!COMBO_RE.test(q.combo)) throw new ValidationError('Combinação inválida (formato |A|B|)');
    where.push(`k.combo = ${stringLiteral(q.combo)}`);
  }
  if (opt(q.key_verdict)) {
    if (!KEY_VERDICTS.includes(q.key_verdict)) throw new ValidationError(`Veredicto da Key inválido: ${q.key_verdict}`);
    where.push(`k.key_verdict = ${stringLiteral(q.key_verdict)}`);
  }
  if (opt(q.asset_class)) where.push(`k.asset_class = ${stringLiteral(q.asset_class)}`);
  if (opt(q.cp2_lei)) where.push(`k.cp2_lei = ${stringLiteral(q.cp2_lei)}`);
  if (opt(q.trade)) {
    // Pesquisa por identificador do trade (UTI ou PROPRIETARY), por prefixo.
    const t = String(q.trade).trim();
    if (!/^[A-Za-z0-9._:-]{1,60}$/.test(t)) throw new ValidationError('Identificador de pesquisa inválido');
    const like = stringLiteral(`${t.replace(/_/g, '\\_')}%`);
    where.push(`(k.uti LIKE ${like} ESCAPE '\\' OR k.proprietary LIKE ${like} ESCAPE '\\')`);
  }
  if (opt(q.min_fields)) where.push(`k.n_fields >= ${intValue(q.min_fields, { min: 1, max: 500 })}`);
  const sort = opt(q.sort) ?? 'fields_desc';
  if (!SORTS[sort]) throw new ValidationError(`Ordenação inválida: ${sort}. Opções: ${Object.keys(SORTS).join(', ')}`);
  const page = opt(q.page) ? intValue(q.page, { min: 1, max: 1_000_000 }) : 1;
  const pageSize = opt(q.page_size) ? intValue(q.page_size, { min: 1, max: MAX_PAGE_SIZE }) : 100;
  return { where, join, field, sort: SORTS[sort], page, pageSize };
}

/**
 * @param pool   createDbPool(...)
 * @param opts.excludedDates  config.excludedDates
 * @param opts.audit  função de auditoria (false para desligar)
 */
export function createApi(pool, { excludedDates = [], audit = defaultAudit } = {}) {
  const log = (event) => audit && audit(event);

  async function timed(endpoint, params, fn) {
    const t0 = Date.now();
    try {
      const out = await fn();
      log({ source: 'ui', endpoint, status: 'ok', params, rowCount: out.rowCount ?? null, ms: Date.now() - t0 });
      return out.body;
    } catch (err) {
      log({ source: 'ui', endpoint, status: 'error', params, error: `${err.name}: ${err.message}`, ms: Date.now() - t0 });
      throw err;
    }
  }

  return {
    /** Jurisdições, datas com regras corridas (key_summary) e versão das regras. Sem dados de breaks. */
    async meta() {
      return timed('meta', {}, () =>
        pool.with(async (db) => {
          let dates = [];
          let hint = null;
          try {
            dates = await db.all(`SELECT business_date, MAX(rules_version) AS rules_version, COUNT(*) AS n_keys
FROM key_summary GROUP BY business_date ORDER BY business_date DESC`);
          } catch {
            hint = 'Ainda não há resultados das regras: correr `npm run rules -- --date AAAA-MM-DD` para cada data.';
          }
          dates = dates.map((r) => ({ date: String(r.business_date).slice(0, 10), rulesVersion: r.rules_version }))
            .filter((r) => !excludedDates.includes(r.date));
          if (!dates.length && !hint) hint = 'Nenhuma data com regras corridas (fora das datas excluídas).';
          return { body: { jurisdictions: JURISDICTIONS, dates, excludedDates, hint }, rowCount: dates.length };
        }),
      );
    },

    // ---- Tools do agente (só agregados) ----
    listMetrics() {
      return describeCatalog();
    },

    tools() {
      return AGENT_TOOLS;
    },

    /** Perguntas sugeridas (chips do ecrã 1) = conjunto de teste do agente. */
    questions() {
      return JSON.parse(readFileSync(resolve(ROOT, 'config/questions.json'), 'utf8')).questions;
    },

    async queryMetric(request, { source = 'api' } = {}) {
      if (!request || typeof request !== 'object') throw new ValidationError('Corpo do pedido em falta');
      return pool.with((db) => runMetric(db, request, { source, excludedDates, audit }));
    },

    // ---- Só UI (linhas) ----
    /** Lista paginada de Keys (transações) com filtros. */
    async listKeys(q = {}) {
      const params = { ...q };
      return timed('keys', params, () => {
        const { where, join, field, sort, page, pageSize } = keysQuery(q);
        const from = `FROM key_summary k\n${join}\nWHERE ${where.join('\n  AND ')}`;
        const sql = `SELECT k.key_id, ${POSITION_KEY.map((c) => `k.${c}`).join(', ')},
  COALESCE(k.uti, k.proprietary) AS trade_id,
  CASE WHEN k.uti IS NULL THEN 'PROPRIETARY' ELSE 'UTI' END AS trade_id_type,
  k.n_fields, k.combo, k.n_so_bnpp, k.n_so_contraparte, k.n_ambos, k.n_divergencia, k.n_sem_regras, k.key_verdict
  ${field ? ', bv.verdict AS field_verdict' : ''}
${from}
ORDER BY ${sort}
LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
        return pool.with(async (db) => {
          const [{ n }] = await db.all(`SELECT COUNT(*) AS n ${from}`);
          const rows = (await db.all(sql)).map((r) => ({ ...r, fields: String(r.combo ?? '').split('|').filter(Boolean) }));
          return { body: { total: Number(n), page, pageSize, rows }, rowCount: rows.length };
        });
      });
    },

    /** Todos os breaks de uma Key: campo ESMA, valor BNPP (TP1), valor other cpty (TP2), veredicto e erros. */
    async getKey(keyId, q = {}) {
      return timed('key', { keyId, date: q.date }, () => {
        if (!isValidDate(q.date)) throw new ValidationError('Parâmetro "date" obrigatório (YYYY-MM-DD)');
        const id = intValue(keyId, { min: 1, max: 100_000_000 });
        const d = dateLiteral(q.date);
        return pool.with(async (db) => {
          const [key] = await db.all(`SELECT k.*, COALESCE(k.uti, k.proprietary) AS trade_id,
  CASE WHEN k.uti IS NULL THEN 'PROPRIETARY' ELSE 'UTI' END AS trade_id_type
FROM key_summary k WHERE k.business_date = ${d} AND k.key_id = ${id}`);
          if (!key) throw new NotFoundError(`Key ${id} não encontrada em ${q.date}`);
          const breaks = await db.all(`SELECT bd.breaking_field, bd.campo, bd.valor_bnpp, bd.valor_other_cpty,
  bv.verdict, bd.veredicto AS verdict_text, bd.erro_bnpp, bd.erro_other_cpty
FROM key_summary k
JOIN break_detail bd ON bd.business_date = ${d} AND ${sameKey('bd', 'k')}
LEFT JOIN break_verdict bv ON bv.business_date = ${d} AND bv.breaking_field = bd.breaking_field AND ${sameKey('bv', 'k')}
WHERE k.business_date = ${d} AND k.key_id = ${id}
ORDER BY bd.campo`);
          const fields = String(key.combo ?? '').split('|').filter(Boolean);
          return { body: { key: { ...key, fields }, breaks }, rowCount: breaks.length };
        });
      });
    },
  };
}
