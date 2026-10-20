// Faixa de 4 KPIs do dia. Tudo via query_metric (as mesmas tools que o agente vai usar).
import { api, onDate } from '../api.js';
import { useAsync } from '../hooks.js';
import { fmtInt, fmtPct, fmtSignedPct, pct, shortDate } from '../format.js';

export function KpiStrip({ date }) {
  const dod = useAsync(() => api.query({ metric: 'breaks_dod', filters: onDate(date), limit: 10000 }), [date]);
  const keys = useAsync(() => api.query({ metric: 'key_verdict', filters: onDate(date) }), [date]);

  const rows = dod.data?.rows ?? [];
  const today = rows.reduce((s, r) => s + Number(r.today), 0);
  const prev = rows.reduce((s, r) => s + Number(r.previous), 0);
  const prevDate = rows[0]?.previous_date;
  const kv = Object.fromEntries((keys.data?.rows ?? []).map((r) => [r.key_verdict, Number(r.n_keys)]));
  const nKeys = Object.values(kv).reduce((s, n) => s + n, 0);
  const identified = (kv.bnpp ?? 0) + (kv.contraparte ?? 0) + (kv.misto ?? 0);
  const fields = rows.filter((r) => Number(r.today) > 0).length;

  const loading = dod.loading || keys.loading;
  const v = (x) => (loading ? '…' : x);
  return (
    <section className="kpis" aria-label="Indicadores do dia">
      <div className="kpi">
        <div className="label">Breaks</div>
        <div className="value">{v(fmtInt(today))}</div>
        <div className="sub">{v(`${fmtInt(fields)} campos em break`)}</div>
      </div>
      <div className="kpi">
        <div className="label">Variação vs {prevDate ? shortDate(prevDate) : 'dia anterior'}</div>
        <div className="value">{v(prevDate ? fmtSignedPct(pct(today - prev, prev)) : '—')}</div>
        <div className="sub">{v(prevDate ? `${fmtInt(prev)} breaks em ${shortDate(prevDate)}` : 'sem dia anterior disponível')}</div>
      </div>
      <div className="kpi">
        <div className="label">Transações (Keys)</div>
        <div className="value">{v(fmtInt(nKeys))}</div>
        <div className="sub">{v(nKeys ? `${(today / nKeys).toLocaleString('de-DE', { maximumFractionDigits: 1 })} campos por transação` : '—')}</div>
      </div>
      <div className="kpi" title="Transações em que nenhum campo tem o lado errado identificado pelas regras ESMA">
        <div className="label">Sem explicação pelas regras</div>
        <div className="value">{v(fmtPct(pct(kv.sem_explicacao ?? 0, nKeys)))}</div>
        <div className="sub">{v(`${fmtInt(identified)} transações com lado identificado`)}</div>
      </div>
      {(dod.error || keys.error) && <div className="error" style={{ gridColumn: '1 / -1', margin: 8 }}>{(dod.error || keys.error).message}</div>}
    </section>
  );
}
