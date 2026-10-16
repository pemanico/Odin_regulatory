// Executa uma métrica: compila, corre no motor e regista auditoria.
import { compileMetric } from './compiler.js';
import { audit as defaultAudit } from '../audit.js';

/**
 * @param db  interface { all(sql) } (DuckDB ou SQLite de testes)
 * @param request  { metric, dimensions?, filters?, limit? }
 * @param opts.audit  função de auditoria (false para desligar)
 * @param opts.source  origem do pedido (cli, api, agent...)
 */
export async function runMetric(db, request, { audit = defaultAudit, source = 'cli' } = {}) {
  const t0 = Date.now();
  let compiled;
  try {
    compiled = compileMetric(request);
    const rows = compiled.postprocess(await db.all(compiled.sql));
    const ms = Date.now() - t0;
    if (audit) audit({ source, status: 'ok', request, sql: compiled.sql, rowCount: rows.length, ms });
    return { metric: compiled.metric, title: compiled.title, sql: compiled.sql, rows, ms };
  } catch (err) {
    if (audit) {
      audit({ source, status: 'error', request, sql: compiled?.sql, error: `${err.name}: ${err.message}`, ms: Date.now() - t0 });
    }
    throw err;
  }
}
