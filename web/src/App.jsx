import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useAsync, useKeys } from './hooks.js';
import { useRoute, href, navigate } from './router.js';
import { fmtDate } from './format.js';
import { TooltipProvider } from './components/Tooltip.jsx';
import { KpiStrip } from './components/KpiStrip.jsx';
import { Top10 } from './views/Top10.jsx';
import { Drill } from './views/Drill.jsx';
import { Query } from './views/Query.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';

const VIEWS = [
  { id: 'query', key: '1', label: 'Query' },
  { id: 'top10', key: '2', label: 'Top 10' },
  { id: 'drill', key: '3', label: 'Drill-down' },
];

export function App() {
  const meta = useAsync(() => api.meta(), []);
  const route = useRoute();
  const [jurisdiction, setJurisdiction] = useState('EMIR');
  const [date, setDate] = useState(null);
  const dates = meta.data?.dates ?? [];

  // Date: the one in the URL (shared drill-down / agent) or the most recent one with rules.
  useEffect(() => {
    if (!dates.length) return;
    const wanted = route.params.date;
    setDate((cur) => (wanted && dates.some((d) => d.date === wanted) ? wanted : cur ?? dates[0].date));
  }, [meta.data, route.params.date]);

  useKeys(Object.fromEntries(VIEWS.map((v) => [v.key, () => navigate(v.id, v.id === 'drill' ? route.params : {})])), [route]);

  const current = dates.find((d) => d.date === date);
  return (
    <TooltipProvider>
      <div className="app">
        <header className="topbar">
          <div className="brand"><span className="mark">◆ ODIN</span> Regulatory <small>reconciliation breaks</small></div>
          <div className="seg" role="group" aria-label="Jurisdiction">
            {(meta.data?.jurisdictions ?? [{ id: 'EMIR', label: 'EMIR', enabled: true }]).map((j) => (
              <button key={j.id} aria-pressed={jurisdiction === j.id} disabled={!j.enabled}
                title={j.enabled ? j.label : `${j.label}: not available yet`} onClick={() => setJurisdiction(j.id)}>
                {j.label}
              </button>
            ))}
          </div>
          <nav className="nav">
            {VIEWS.map((v) => (
              <a key={v.id} href={href(v.id, v.id === 'drill' && route.view === 'drill' ? route.params : {})}
                aria-current={route.view === v.id ? 'page' : undefined}>
                <kbd>{v.key}</kbd>{v.label}
              </a>
            ))}
          </nav>
          <div className="spacer" />
          <label className="secondary">
            Business date{' '}
            <select value={date ?? ''} onChange={(e) => setDate(e.target.value)} disabled={!dates.length}>
              {dates.map((d) => <option key={d.date} value={d.date}>{fmtDate(d.date)}</option>)}
            </select>
          </label>
          {current && <span className="badge" title="Version of the ESMA rules catalog used on this date">rules {current.rulesVersion}</span>}
        </header>

        {date ? <KpiStrip date={date} /> : <div className="kpis" />}

        <main className="main">
          {meta.error && <div className="error">Could not reach the API: {meta.error.message}</div>}
          {meta.data?.hint && <div className="error">{meta.data.hint}</div>}
          <ErrorBoundary key={route.view} label={`The ${route.view} screen`}>
            {date && route.view === 'top10' && <Top10 date={date} />}
            {date && route.view === 'drill' && <Drill date={date} params={route.params} />}
            {date && route.view === 'query' && <Query date={date} />}
          </ErrorBoundary>
        </main>
      </div>
    </TooltipProvider>
  );
}
