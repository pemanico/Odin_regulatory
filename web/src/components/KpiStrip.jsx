// Strip with the 4 KPIs of the day. Everything via query_metric (the same tools the agent will use).
import { api, onDate } from '../api.js';
import { useAsync } from '../hooks.js';
import { fmtInt, fmtDec, fmtPct, fmtSignedPct, pct, shortDate } from '../format.js';

export function KpiStrip({ date }) {
  const dod = useAsync(() => api.query({ metric: 'breaks_dod', filters: onDate(date), limit: 10000 }), [date]);
  const keys = useAsync(() => api.query({ metric: 'key_verdict', filters: onDate(date) }), [date]);

  const rows = dod.data?.rows ?? [];
  const today = rows.reduce((s, r) => s + Number(r.today), 0);
  const prev = rows.reduce((s, r) => s + Number(r.previous), 0);
  const prevDate = rows[0]?.previous_date;
  const kv = Object.fromEntries((keys.data?.rows ?? []).map((r) => [r.key_verdict, Number(r.n_keys)]));
  const nKeys = Object.values(kv).reduce((s, n) => s + n, 0);
  const identified = (kv.bnpp ?? 0) + (kv.counterparty ?? 0) + (kv.mixed ?? 0);
  const fields = rows.filter((r) => Number(r.today) > 0).length;

  const loading = dod.loading || keys.loading;
  const v = (x) => (loading ? '…' : x);
  return (
    <section className="kpis" aria-label="Indicators of the day">
      <div className="kpi">
        <div className="label">Breaks</div>
        <div className="value">{v(fmtInt(today))}</div>
        <div className="sub">{v(`${fmtInt(fields)} breaking fields`)}</div>
      </div>
      <div className="kpi">
        <div className="label">Change vs {prevDate ? shortDate(prevDate) : 'previous day'}</div>
        <div className="value">{v(prevDate ? fmtSignedPct(pct(today - prev, prev)) : '—')}</div>
        <div className="sub">{v(prevDate ? `${fmtInt(prev)} breaks on ${shortDate(prevDate)}` : 'no previous day available')}</div>
      </div>
      <div className="kpi">
        <div className="label">Transactions (Keys)</div>
        <div className="value">{v(fmtInt(nKeys))}</div>
        <div className="sub">{v(nKeys ? `${fmtDec(today / nKeys)} fields per transaction` : '—')}</div>
      </div>
      <div className="kpi" title="Transactions in which no field has the wrong side identified by the ESMA rules">
        <div className="label">Unexplained by the rules</div>
        <div className="value">{v(fmtPct(pct(kv.unexplained ?? 0, nKeys)))}</div>
        <div className="sub">{v(`${fmtInt(identified)} transactions with the side identified`)}</div>
      </div>
      {(dod.error || keys.error) && <div className="error" style={{ gridColumn: '1 / -1', margin: 8 }}>{(dod.error || keys.error).message}</div>}
    </section>
  );
}
