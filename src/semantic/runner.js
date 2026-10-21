// Runs a metric: compiles it, runs it on the engine and writes the audit log.
import { compileMetric } from './compiler.js';
import { audit as defaultAudit } from '../audit.js';

/**
 * @param db  interface { all(sql) } (DuckDB or the SQLite test adapter)
 * @param request  { metric, dimensions?, filters?, limit? }
 * @param opts.audit  audit function (false to switch off)
 * @param opts.source  origin of the request (cli, api, agent...)
 * @param opts.excludedDates  business dates to skip in day-on-day comparisons (config.excludedDates)
 */
export async function runMetric(db, request, { audit = defaultAudit, source = 'cli', excludedDates = [] } = {}) {
  const t0 = Date.now();
  let compiled;
  try {
    compiled = compileMetric(request, { excludedDates });
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
