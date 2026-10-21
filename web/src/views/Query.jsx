// Screen 1: query as a conversation thread. Today the request comes from a suggested question (chip) or the advanced query;
// once the agent is connected it comes from free text — the answer card is the same (query_metric -> table/chart).
// The suggested questions (config/questions.json) are the agent's test set.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useAsync } from '../hooks.js';
import { href } from '../router.js';
import { fmtInt, fmtPct, fmtSigned, fmtDate, fieldName } from '../format.js';
import { VERDICT, KEY_VERDICT } from '../verdicts.js';
import { VerdictTag } from '../components/Verdict.jsx';
import { useTooltip } from '../components/Tooltip.jsx';

const COLUMN_LABELS = {
  breaking_field: 'Field', n_breaks: 'Breaks', n_keys: 'Transactions', verdict: 'Verdict', key_verdict: 'Transaction verdict',
  asset_class: 'Asset class', cp2_lei: 'Counterparty LEI', cp1_lei: 'Counterparty 1 LEI', business_date: 'Business date',
  today: 'Today', previous: 'Previous day', previous_date: 'Previous date', delta: 'Δ', delta_pct: 'Δ %', combo: 'Combination',
  n_fields: 'Fields', bnpp: 'BNPP', counterparty: 'Counterparty', mixed: 'Mixed', unexplained: 'Unexplained',
  raw_rows: 'Raw rows', distinct_breaks: 'Distinct breaks', distinct_positions: 'Transactions', conflicting_keys: 'Conflicting keys',
  dup_factor: 'Duplication factor', business_line: 'Business line',
  same: 'Same', changed: 'Changed', new: 'New', resolved: 'Resolved', breaks_today: 'Breaks today', breaks_previous: 'Breaks previous day',
  pct_same: '% same', pct_changed: '% changed', pct_new: '% new',
};
const HIDDEN = new Set(['combo_key']);
const MEASURES = ['n_breaks', 'n_keys', 'today'];
const withDate = (req, date) => JSON.parse(JSON.stringify(req).replaceAll('$date', date));

function cell(col, v) {
  if (v === null || v === undefined) return <span className="muted">—</span>;
  if (col === 'verdict') return <VerdictTag def={VERDICT[v]} />;
  if (col === 'key_verdict') return <VerdictTag def={KEY_VERDICT[v]} />;
  if (col === 'breaking_field') return <span className="field">{fieldName(v)}</span>;
  if (col === 'delta') return fmtSigned(v);
  if (col === 'delta_pct' || col.startsWith('pct_')) return fmtPct(v);
  if (col.endsWith('date')) return fmtDate(v);
  if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && !/lei|trade|uti/.test(col))) {
    return Number.isInteger(Number(v)) ? fmtInt(v) : Number(v).toLocaleString('en-GB', { maximumFractionDigits: 2 });
  }
  return <span className={/lei|combo/.test(col) ? 'mono' : undefined}>{String(v)}</span>;
}

const isNumericCol = (rows, col) => rows.every((r) => r[col] === null || !Number.isNaN(Number(r[col]))) && !/lei|date/.test(col);

/** Drill-down filters from an aggregated row (null if the row does not point to breaks). */
function drillParams(row, request, date) {
  const p = { date };
  for (const f of request.filters ?? []) {
    if (f.op !== 'eq') continue;
    if (f.dimension === 'breaking_field') p.field = fieldName(f.value);
    if (['asset_class', 'cp2_lei', 'key_verdict'].includes(f.dimension)) p[f.dimension] = f.value;
    if (f.dimension === 'verdict') p.field_verdict = f.value;
  }
  if (row.breaking_field) p.field = fieldName(row.breaking_field);
  if (row.combo_key) p.combo = row.combo_key;
  for (const k of ['asset_class', 'cp2_lei', 'key_verdict']) if (row[k]) p[k] = row[k];
  if (row.verdict) p.field_verdict = row.verdict;
  if (p.field_verdict && !p.field) delete p.field_verdict; // the per-break verdict only filters within a field
  const useful = Object.keys(p).length > 1;
  if (!useful) return null;
  p.view = p.field && !p.combo && !p.field_verdict ? 'combos' : 'keys';
  return p;
}

function Bars({ rows, labelCol, valueCol }) {
  const tip = useTooltip();
  const top = rows.slice(0, 15);
  const max = Math.max(...top.map((r) => Number(r[valueCol]) || 0), 1);
  return (
    <div className="hbars" onMouseLeave={tip.hide}>
      {top.map((r, i) => {
        const label = labelCol === 'verdict' ? VERDICT[r[labelCol]]?.short : labelCol === 'key_verdict' ? KEY_VERDICT[r[labelCol]]?.short : r[labelCol];
        const color = labelCol === 'verdict' ? VERDICT[r[labelCol]]?.color : labelCol === 'key_verdict' ? KEY_VERDICT[r[labelCol]]?.color : undefined;
        return (
          <div className="hbar" key={i}
            onMouseMove={(e) => tip.show(e, <><div className="t-title">{String(label ?? '—')}</div><div className="t-row"><span>{COLUMN_LABELS[valueCol] ?? valueCol}</span><span className="mono">{fmtInt(r[valueCol])}</span></div></>)}>
            <span className={`name${labelCol === 'breaking_field' || /lei/.test(labelCol) ? ' mono' : ''}`}>{String(label ?? '—')}</span>
            <div className="track"><div className="fill" style={{ width: `${(Number(r[valueCol]) / max) * 100}%`, background: color }} /></div>
            <span className="v mono">{fmtInt(r[valueCol])}</span>
          </div>
        );
      })}
      {rows.length > 15 && <div className="hint">+{rows.length - 15} more rows in the table</div>}
    </div>
  );
}

function ResultCard({ item, onRemove }) {
  const [showSql, setShowSql] = useState(false);
  const { question, request, date, result, error, loading } = item;
  const rows = result?.rows ?? [];
  const cols = rows.length ? Object.keys(rows[0]).filter((c) => !HIDDEN.has(c)) : [];
  const measure = MEASURES.find((m) => cols.includes(m));
  const dims = cols.filter((c) => !isNumericCol(rows, c) && c !== 'previous_date');
  const chart = measure && dims.length === 1 && rows.length > 1;
  const anyDrill = rows.some((r) => drillParams(r, request, date));
  return (
    <article className="panel card">
      <div className="panel-head">
        <div className="q"><span className="who">QUESTION</span><b>{question}</b></div>
        <div className="spacer" />
        <div className="meta">
          <span className="mono">{request.metric}</span>
          <span>{fmtDate(date)}</span>
          {result && <span>{fmtInt(rows.length)} rows · {result.ms} ms</span>}
          {result && <button className="btn link" onClick={() => setShowSql((s) => !s)}>{showSql ? 'hide SQL' : 'show SQL'}</button>}
          <button className="btn link" onClick={onRemove} aria-label="Remove answer">×</button>
        </div>
      </div>
      {showSql && <pre className="sql">{result.sql}</pre>}
      {loading && <div className="empty">Computing…</div>}
      {error && <div className="error" style={{ margin: 12 }}>{error.message}</div>}
      {result && !rows.length && <div className="empty">No results for this date.</div>}
      {rows.length > 0 && (
        <div className={`body${chart ? '' : ' single'}`}>
          <div className="tablewrap">
            <table className="grid">
              <thead>
                <tr>
                  {cols.map((c) => <th key={c} className={isNumericCol(rows, c) ? 'num' : undefined}>{COLUMN_LABELS[c] ?? c}</th>)}
                  {anyDrill && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const dp = drillParams(r, request, date);
                  return (
                    <tr key={i}>
                      {cols.map((c) => <td key={c} className={isNumericCol(rows, c) ? 'num' : undefined}>{cell(c, r[c])}</td>)}
                      {anyDrill && <td className="num">{dp && <a href={href('drill', dp)} title="See the breaks (drill-down)">see breaks →</a>}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {chart && <Bars rows={rows} labelCol={dims[0]} valueCol={measure} />}
        </div>
      )}
    </article>
  );
}

function Builder({ date, onAsk }) {
  const catalog = useAsync(() => api.metrics(), []);
  const metrics = (catalog.data?.metrics ?? []).filter((m) => m.available);
  const [metric, setMetric] = useState('breaks_by_field');
  const [dims, setDims] = useState(null);
  const [filters, setFilters] = useState([{ dimension: '', value: '' }]);
  const [limit, setLimit] = useState('');
  const m = metrics.find((x) => x.id === metric);
  const allDims = Object.keys(catalog.data?.dimensions ?? {}).filter((d) => d !== 'business_date');
  const chosen = dims ?? m?.defaultDimensions ?? [];

  const submit = (e) => {
    e.preventDefault();
    const request = {
      metric,
      ...(m?.allowedDimensions ? { dimensions: chosen } : {}),
      filters: [
        { dimension: 'business_date', op: 'eq', value: '$date' },
        ...filters.filter((f) => f.dimension && f.value.trim()).map((f) => ({ dimension: f.dimension, op: 'eq', value: f.value.trim() })),
      ],
      ...(limit ? { limit: Number(limit) } : {}),
    };
    onAsk(`Advanced query: ${m?.title ?? metric}`, request);
  };

  return (
    <form className="builder" onSubmit={submit}>
      <div className="row">
        <label className="secondary">Metric{' '}
          <select value={metric} onChange={(e) => { setMetric(e.target.value); setDims(null); }}>
            {metrics.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
          </select>
        </label>
        <span className="hint">{m?.description}</span>
      </div>
      {m?.allowedDimensions && (
        <div className="row">
          <span className="secondary">Group by</span>
          <div className="dims">
            {m.allowedDimensions.filter((d) => d !== 'business_date').map((d) => (
              <label key={d}>
                <input type="checkbox" checked={chosen.includes(d)}
                  onChange={(e) => setDims(e.target.checked ? [...chosen, d] : chosen.filter((x) => x !== d))} />
                {catalog.data.dimensions[d]?.label ?? d}
              </label>
            ))}
          </div>
        </div>
      )}
      {filters.map((f, i) => (
        <div className="row" key={i}>
          <span className="secondary">Filter</span>
          <select value={f.dimension} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, dimension: e.target.value } : x)))}>
            <option value="">—</option>
            {allDims.map((d) => <option key={d} value={d}>{catalog.data.dimensions[d]?.label ?? d}</option>)}
          </select>
          <span className="muted">=</span>
          <input type="text" value={f.value} size={24} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          {i === filters.length - 1 && filters.length < 3 && (
            <button type="button" className="btn link" onClick={() => setFilters([...filters, { dimension: '', value: '' }])}>+ filter</button>
          )}
        </div>
      ))}
      <div className="row">
        <label className="secondary">Limit{' '}<input type="number" min="1" max="10000" style={{ width: 80 }} value={limit} placeholder={m?.defaultLimit} onChange={(e) => setLimit(e.target.value)} /></label>
        <span className="hint">Business date: {fmtDate(date)} (from the top bar)</span>
        <div className="spacer" />
        <button className="btn primary" type="submit">Run</button>
      </div>
    </form>
  );
}

let seq = 0;
export function Query({ date }) {
  const questions = useAsync(() => api.questions(), []);
  const [items, setItems] = useState([]);
  const [advanced, setAdvanced] = useState(false);
  const topRef = useRef(null);

  const ask = async (question, template) => {
    const id = ++seq;
    const request = withDate(template, date);
    // Newest answer first, right below the suggestions, so it is always in view.
    setItems((xs) => [{ id, question, request, date, loading: true }, ...xs]);
    try {
      const result = await api.query(request);
      setItems((xs) => xs.map((x) => (x.id === id ? { ...x, loading: false, result } : x)));
    } catch (error) {
      setItems((xs) => xs.map((x) => (x.id === id ? { ...x, loading: false, error } : x)));
    }
  };
  useEffect(() => topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), [items.length]);

  return (
    <div className="query">
      <div className="panel">
        <div className="panel-head">
          <h2>Suggested questions</h2>
          <span className="hint">answered with certified metrics; each answer shows the SQL and links to the breaks</span>
        </div>
        <div style={{ padding: 12 }} className="suggest">
          {(questions.data ?? []).map((q) => <button key={q.id} onClick={() => ask(q.text, q.request)}>{q.text}</button>)}
          {questions.error && <span className="error">{questions.error.message}</span>}
        </div>
      </div>

      <div className="thread" aria-live="polite" ref={topRef}>
        {!items.length && <div className="empty">Pick a suggested question or use the advanced query.</div>}
        {items.map((it) => <ResultCard key={it.id} item={it} onRemove={() => setItems((xs) => xs.filter((x) => x.id !== it.id))} />)}
      </div>

      <div className="composer">
        {advanced && <div className="panel" style={{ marginBottom: 8 }}><Builder date={date} onAsk={ask} /></div>}
        <div className="prompt">
          <input type="text" disabled placeholder="Free-text question: available once the agent is connected. Use the suggestions or the advanced query." />
          <button className="btn" onClick={() => setAdvanced((a) => !a)}>{advanced ? 'Close advanced query' : 'Advanced query'}</button>
        </div>
      </div>
    </div>
  );
}
