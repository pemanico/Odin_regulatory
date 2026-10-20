// Ecrã 2: top 10 de breaking fields na business date, com variação face ao dia anterior e a composição por veredicto.
// Clicar numa linha abre o drill-down do campo; clicar num segmento abre só os breaks desse veredicto.
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
        <h2>Top {n} campos em break</h2>
        <div className="seg" role="group" aria-label="Número de campos">
          {[10, 20].map((k) => <button key={k} aria-pressed={n === k} onClick={() => setN(k)}>Top {k}</button>)}
        </div>
        <span className="hint">
          {data.data?.prevDate ? `Variação vs ${shortDate(data.data.prevDate)} (dia anterior disponível)` : 'Sem dia anterior disponível'}
          {' · '}<kbd>j</kbd>/<kbd>k</kbd> navegar, <kbd>Enter</kbd> abrir
        </span>
        <div className="spacer" />
        <Legend defs={VERDICTS} />
      </div>
      {data.error && <div className="error">{data.error.message}</div>}
      {data.loading && !rows.length ? <div className="empty">A carregar…</div> : (
        <table className="grid">
          <thead>
            <tr>
              <th className="rank">#</th>
              <th>Campo</th>
              <th className="num">Breaks</th>
              <th className="num">% do top</th>
              <th className="num">Δ D-1</th>
              <th className="num">Δ %</th>
              <th style={{ width: '34%' }}>Veredicto das regras ESMA</th>
              <th className="num" title="Breaks em que as regras identificam o lado errado (BNPP, contraparte ou ambos)">Lado identificado</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const f = fieldName(r.breaking_field);
              const counts = data.data.byField[f] ?? {};
              const ident = (counts.so_bnpp ?? 0) + (counts.so_contraparte ?? 0) + (counts.ambos ?? 0);
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
                  <td className="num">{Object.keys(counts).length ? fmtPct(pct(ident, r.today)) : <span className="muted" title="Sem resultados das regras">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
