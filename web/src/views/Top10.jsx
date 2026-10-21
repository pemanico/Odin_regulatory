// Screen 2: top 10 breaking fields on the business date, with the day-on-day change and the split by verdict.
// Clicking a row opens the field drill-down; clicking a segment opens only the breaks with that verdict.
import { useState } from 'react';
import { api, onDate } from '../api.js';
import { useAsync, useKeys } from '../hooks.js';
import { navigate } from '../router.js';
import { fmtInt, fmtSigned, fmtSignedPct, fmtPct, pct, shortDate, fieldName } from '../format.js';
import { VERDICTS } from '../verdicts.js';
import { VerdictBar, Legend } from '../components/Verdict.jsx';

export function Top10({ date }) {
  const [n, setN] = useState(10);
  const data = useAsync(async () => {
    const dod = await api.query({ metric: 'breaks_dod', filters: onDate(date), limit: n });
    const fields = dod.rows.filter((r) => Number(r.today) > 0).map((r) => fieldName(r.breaking_field));
    const rv = fields.length
      ? await api.query({
        metric: 'rule_verdict',
        dimensions: ['breaking_field', 'verdict'],
        filters: onDate(date, [{ dimension: 'breaking_field', op: 'in', value: fields }]),
        limit: 1000,
      })
      : { rows: [] };
    const byField = {};
    for (const r of rv.rows) (byField[fieldName(r.breaking_field)] ??= {})[r.verdict] = Number(r.n_breaks);
    return { rows: dod.rows.filter((r) => Number(r.today) > 0), byField, prevDate: dod.rows[0]?.previous_date };
  }, [date, n]);

  const rows = data.data?.rows ?? [];
  const [sel, setSel] = useState(0);
  const open = (r, extra = {}) => navigate('drill', { date, field: fieldName(r.breaking_field), ...extra });
  useKeys({
    j: () => setSel((s) => Math.min(s + 1, rows.length - 1)),
    k: () => setSel((s) => Math.max(s - 1, 0)),
    Enter: () => rows[sel] && open(rows[sel]),
  }, [rows, sel]);

  const total = rows.reduce((s, r) => s + Number(r.today), 0);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Top {n} breaking fields</h2>
        <div className="seg" role="group" aria-label="Number of fields">
          {[10, 20].map((k) => <button key={k} aria-pressed={n === k} onClick={() => setN(k)}>Top {k}</button>)}
        </div>
        <span className="hint">
          {data.data?.prevDate ? `Change vs ${shortDate(data.data.prevDate)} (previous available day)` : 'No previous day available'}
          {' · '}<kbd>j</kbd>/<kbd>k</kbd> navigate, <kbd>Enter</kbd> open
        </span>
        <div className="spacer" />
        <Legend defs={VERDICTS} />
      </div>
      {data.error && <div className="error">{data.error.message}</div>}
      {data.loading && !rows.length ? <div className="empty">Loading…</div> : (
        <table className="grid">
          <thead>
            <tr>
              <th className="rank">#</th>
              <th>Field</th>
              <th className="num">Breaks</th>
              <th className="num">% of top</th>
              <th className="num">Δ D-1</th>
              <th className="num">Δ %</th>
              <th style={{ width: '34%' }}>ESMA rules verdict</th>
              <th className="num" title="Breaks in which the rules identify the wrong side (BNPP, counterparty or both)">Side identified</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const f = fieldName(r.breaking_field);
              const counts = data.data.byField[f] ?? {};
              const ident = (counts.bnpp_only ?? 0) + (counts.cpty_only ?? 0) + (counts.both ?? 0);
              return (
                <tr key={f} className={`clickable${i === sel ? ' selected' : ''}`} onClick={() => open(r)} onMouseEnter={() => setSel(i)}>
                  <td className="rank num">{i + 1}</td>
                  <td className="field">{f}</td>
                  <td className="num">{fmtInt(r.today)}</td>
                  <td className="num muted">{fmtPct(pct(r.today, total))}</td>
                  <td className={`num ${Number(r.delta) > 0 ? 'delta-up' : 'delta-down'}`}>{fmtSigned(r.delta)}</td>
                  <td className="num secondary">{fmtSignedPct(r.delta_pct)}</td>
                  <td>
                    <VerdictBar defs={VERDICTS} counts={counts} title={f}
                      onPick={(v) => open(r, { field_verdict: v, view: 'keys' })} />
                  </td>
                  <td className="num">{Object.keys(counts).length ? fmtPct(pct(ident, r.today)) : <span className="muted" title="No rules results">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
