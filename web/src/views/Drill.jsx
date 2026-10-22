// Screen 3: drill-down field -> field combinations (optional) -> transactions (Keys) -> all breaks of the Key.
// The whole state is in the URL (#/drill?field=...&key_verdict=...): it is what the agent's open_drilldown tool produces.
// The rows (UTI, LEIs, values) come from /api/keys, a UI-only endpoint: the agent never sees them.
import { useEffect, useRef, useState } from 'react';
import { api, onDate } from '../api.js';
import { useAsync, useKeys } from '../hooks.js';
import { navigate } from '../router.js';
import { fmtInt, fmtPct, pct, fieldName } from '../format.js';
import { VERDICTS, VERDICT, KEY_VERDICTS, KEY_VERDICT, keyCounts } from '../verdicts.js';
import { VerdictBar, VerdictTag, Legend } from '../components/Verdict.jsx';
import { KeyDetail } from '../components/KeyDetail.jsx';

const FILTER_LABELS = {
  field: 'Field', field_verdict: 'Field verdict', combo: 'Combination', key_verdict: 'Transaction verdict',
  asset_class: 'Asset class', cp2_lei: 'Counterparty LEI', trade: 'Identifier', min_fields: 'Min. fields',
};
const SORTS = [
  ['fields_desc', 'Most fields first'],
  ['fields_asc', 'Fewest fields first'],
  ['verdict', 'Verdict (mixed first)'],
  ['counterparty', 'Counterparty'],
];
const comboText = (c) => String(c ?? '').split('|').filter(Boolean).join(' + ');

function filterValueText(k, v) {
  if (k === 'field_verdict') return VERDICT[v]?.short ?? v;
  if (k === 'key_verdict') return KEY_VERDICT[v]?.short ?? v;
  if (k === 'combo') return comboText(v);
  return v;
}

export function Drill({ date, params }) {
  const p = { ...params };
  delete p.date;
  const view = p.view || (p.field && !p.combo && !p.field_verdict ? 'combos' : 'keys');
  const set = (changes) => {
    const next = { ...p, ...changes, date };
    if (!('page' in changes)) delete next.page;
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '') delete next[k];
    navigate('drill', next);
  };

  const fields = useAsync(() => api.query({ metric: 'breaks_dod', filters: onDate(date), limit: 300 }), [date]);
  const assets = useAsync(() => api.query({ metric: 'key_verdict', dimensions: ['asset_class'], filters: onDate(date) }), [date]);

  const [fieldInput, setFieldInput] = useState(p.field ?? '');
  const [tradeInput, setTradeInput] = useState(p.trade ?? '');
  useEffect(() => { setFieldInput(p.field ?? ''); }, [p.field]);
  useEffect(() => { setTradeInput(p.trade ?? ''); }, [p.trade]);
  const tradeRef = useRef(null);

  const active = Object.keys(FILTER_LABELS).filter((k) => p[k]);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Drill-down</h2>
        <div className="seg" role="group" aria-label="View">
          <button aria-pressed={view === 'combos'} onClick={() => set({ view: 'combos' })}>Field combinations</button>
          <button aria-pressed={view === 'keys'} onClick={() => set({ view: 'keys' })}>Transactions</button>
        </div>
        <div className="active-filters">
          {active.map((k) => (
            <span key={k} className="af">
              <span className="muted">{FILTER_LABELS[k]}:</span> <span className="mono">{filterValueText(k, p[k])}</span>
              <button aria-label={`Remove filter ${FILTER_LABELS[k]}`}
                onClick={() => set({ [k]: undefined, ...(k === 'field' ? { field_verdict: undefined } : {}) })}>×</button>
            </span>
          ))}
        </div>
      </div>

      <form className="filters" onSubmit={(e) => { e.preventDefault(); set({ field: fieldName(fieldInput) || undefined, trade: tradeInput.trim() || undefined }); }}>
        <label>Field
          <input type="text" list="fields-list" value={fieldInput} placeholder="e.g. VALUATION_AMT" size={22}
            onChange={(e) => setFieldInput(e.target.value)}
            onBlur={() => fieldName(fieldInput) !== (p.field ?? '') && set({ field: fieldName(fieldInput) || undefined, field_verdict: undefined })} />
          <datalist id="fields-list">
            {(fields.data?.rows ?? []).map((r) => <option key={r.breaking_field} value={fieldName(r.breaking_field)}>{fmtInt(r.today)} breaks</option>)}
          </datalist>
        </label>
        {p.field && (
          <label>Field verdict
            <select value={p.field_verdict ?? ''} onChange={(e) => set({ field_verdict: e.target.value || undefined, view: 'keys' })}>
              <option value="">all</option>
              {VERDICTS.map((v) => <option key={v.id} value={v.id}>{v.short}</option>)}
            </select>
          </label>
        )}
        <label>Transaction
          <select value={p.key_verdict ?? ''} onChange={(e) => set({ key_verdict: e.target.value || undefined })}>
            <option value="">all</option>
            {KEY_VERDICTS.map((v) => <option key={v.id} value={v.id}>{v.short}</option>)}
          </select>
        </label>
        <label>Asset class
          <select value={p.asset_class ?? ''} onChange={(e) => set({ asset_class: e.target.value || undefined })}>
            <option value="">all</option>
            {(assets.data?.rows ?? []).map((r) => <option key={r.asset_class} value={r.asset_class}>{r.asset_class} ({fmtInt(r.n_keys)})</option>)}
          </select>
        </label>
        {view === 'keys' && (
          <>
            <label>Min. fields
              <input type="number" min="1" max="500" style={{ width: 64 }} value={p.min_fields ?? ''}
                onChange={(e) => set({ min_fields: e.target.value || undefined })} />
            </label>
            <label>UTI / proprietary <kbd>/</kbd>
              <input ref={tradeRef} type="text" value={tradeInput} placeholder="prefix" size={18}
                onChange={(e) => setTradeInput(e.target.value)} />
            </label>
            <label>Sort
              <select value={p.sort ?? 'fields_desc'} onChange={(e) => set({ sort: e.target.value })}>
                {SORTS.map(([id, l]) => <option key={id} value={id}>{l}</option>)}
              </select>
            </label>
          </>
        )}
        <button type="submit" className="btn">Apply</button>
      </form>

      {view === 'combos'
        ? <Combos date={date} p={p} onPick={(combo, keyVerdict) => set({ combo, view: 'keys', ...(keyVerdict ? { key_verdict: keyVerdict } : {}) })} />
        : <Keys date={date} p={p} set={set} focusSearch={() => tradeRef.current?.focus()} />}
    </section>
  );
}

function Combos({ date, p, onPick }) {
  const extra = [
    p.field && { dimension: 'breaking_field', op: 'eq', value: p.field },
    p.key_verdict && { dimension: 'key_verdict', op: 'eq', value: p.key_verdict },
    p.asset_class && { dimension: 'asset_class', op: 'eq', value: p.asset_class },
  ].filter(Boolean);
  const data = useAsync(async () => {
    const [combos, totals] = await Promise.all([
      api.query({ metric: 'field_combinations', filters: onDate(date, extra), limit: 50 }),
      api.query({ metric: 'field_combinations', filters: onDate(date, extra), limit: 10000 }),
    ]);
    const nKeys = totals.rows.reduce((s, r) => s + Number(r.n_keys), 0);
    return { rows: combos.rows, nKeys, nCombos: totals.rows.length };
  }, [date, p.field, p.key_verdict, p.asset_class]);
  const rows = data.data?.rows ?? [];
  const [sel, setSel] = useState(0);
  useKeys({
    j: () => setSel((s) => Math.min(s + 1, rows.length - 1)),
    k: () => setSel((s) => Math.max(s - 1, 0)),
    Enter: () => rows[sel] && onPick(rows[sel].combo_key),
  }, [rows, sel]);
  const top = rows.reduce((s, r) => s + Number(r.n_keys), 0);

  return (
    <>
      <div className="panel-head">
        <span className="secondary">
          {data.data && <>
            <b className="mono">{fmtInt(data.data.nKeys)}</b> transactions in <b className="mono">{fmtInt(data.data.nCombos)}</b> combinations
            {' · '}the top {rows.length} cover <b className="mono">{fmtPct(pct(top, data.data.nKeys))}</b>
          </>}
        </span>
        <div className="spacer" />
        <Legend defs={KEY_VERDICTS} />
      </div>
      {data.error && <div className="error">{data.error.message}</div>}
      {data.loading && !rows.length ? <div className="empty">Loading…</div> : !rows.length ? <div className="empty">No transactions with these filters.</div> : (
        <table className="grid">
          <thead>
            <tr>
              <th className="rank">#</th>
              <th>Breaking fields in the same transaction</th>
              <th className="num">Fields</th>
              <th className="num">Transactions</th>
              <th className="num">%</th>
              <th style={{ width: '24%' }}>Transaction verdicts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.combo_key} className={`clickable${i === sel ? ' selected' : ''}`} onClick={() => onPick(r.combo_key)} onMouseEnter={() => setSel(i)}>
                <td className="rank num">{i + 1}</td>
                <td>
                  <div className="chips">
                    {r.combo.split(' + ').map((f) => <span key={f} className={`chip${f === p.field ? ' hl' : ''}`}>{f}</span>)}
                  </div>
                </td>
                <td className="num">{r.n_fields}</td>
                <td className="num">{fmtInt(r.n_keys)}</td>
                <td className="num muted">{fmtPct(pct(r.n_keys, data.data.nKeys))}</td>
                <td><VerdictBar small defs={KEY_VERDICTS} counts={r} title={r.combo} onPick={(v) => onPick(r.combo_key, v)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Keys({ date, p, set, focusSearch }) {
  const page = Number(p.page ?? 1);
  const data = useAsync(() => api.keys({
    date, field: p.field, field_verdict: p.field_verdict, combo: p.combo, key_verdict: p.key_verdict,
    asset_class: p.asset_class, cp2_lei: p.cp2_lei, trade: p.trade, min_fields: p.min_fields, sort: p.sort, page, page_size: 100,
  }), [date, p.field, p.field_verdict, p.combo, p.key_verdict, p.asset_class, p.cp2_lei, p.trade, p.min_fields, p.sort, page]);
  const rows = data.data?.rows ?? [];
  const total = data.data?.total ?? 0;
  const [sel, setSel] = useState(0);
  const [open, setOpen] = useState(() => new Set());
  useEffect(() => { setSel(0); setOpen(new Set()); }, [data.data]);
  const toggle = (id) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const pages = Math.max(1, Math.ceil(total / 100));
  useKeys({
    j: () => setSel((s) => Math.min(s + 1, rows.length - 1)),
    k: () => setSel((s) => Math.max(s - 1, 0)),
    Enter: () => rows[sel] && toggle(rows[sel].key_id),
    ' ': () => rows[sel] && toggle(rows[sel].key_id),
    Escape: () => setOpen(new Set()),
    '/': () => focusSearch(),
    n: () => page < pages && set({ page: page + 1 }),
    p: () => page > 1 && set({ page: page - 1 }),
  }, [rows, sel, page, pages]);
  useEffect(() => {
    document.querySelector('tr.selected')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const from = total ? (page - 1) * 100 + 1 : 0;
  const pager = (
    <div className="pager">
      <span><b className="mono">{fmtInt(from)}–{fmtInt(Math.min(page * 100, total))}</b> of <b className="mono">{fmtInt(total)}</b> transactions</span>
      <button className="btn" disabled={page <= 1} onClick={() => set({ page: page - 1 })} title="Previous page (p)">‹</button>
      <span className="mono">{page}/{fmtInt(pages)}</span>
      <button className="btn" disabled={page >= pages} onClick={() => set({ page: page + 1 })} title="Next page (n)">›</button>
      <span className="hint"><kbd>j</kbd>/<kbd>k</kbd> navigate · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close · <kbd>n</kbd>/<kbd>p</kbd> page</span>
      <div className="spacer" />
      <Legend defs={VERDICTS} />
    </div>
  );

  return (
    <>
      {pager}
      {data.error && <div className="error">{data.error.message}</div>}
      {data.loading && !rows.length ? <div className="empty">Loading…</div> : !rows.length ? <div className="empty">No transactions with these filters.</div> : (
        <table className="grid">
          <thead>
            <tr>
              <th className="rank" />
              <th>Identifier</th>
              <th>Asset class</th>
              <th>Counterparty 1 LEI</th>
              <th>Other counterparty LEI</th>
              {p.field && <th>{fieldName(p.field)}</th>}
              <th className="num">Fields</th>
              <th style={{ width: '18%' }}>Fields by verdict</th>
              <th>Transaction</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isOpen = open.has(r.key_id);
              return [
                <tr key={r.key_id} className={`clickable${i === sel ? ' selected' : ''}`} onClick={() => { setSel(i); toggle(r.key_id); }}>
                  <td className="rank mono">{isOpen ? '▾' : '▸'}</td>
                  <td className="mono" title={r.trade_id_type}>
                    {r.trade_id}{r.trade_id_type === 'PROPRIETARY' && <span className="badge" style={{ marginLeft: 6 }}>prop.</span>}
                  </td>
                  <td>{r.asset_class}</td>
                  <td className="mono secondary">{r.cp1_lei}</td>
                  <td className="mono secondary">
                    {r.cp2_lei}
                    {!p.cp2_lei && (
                      <button className="btn link" title="Filter by this counterparty" aria-label="Filter by this counterparty"
                        onClick={(e) => { e.stopPropagation(); set({ cp2_lei: r.cp2_lei }); }}>⧩</button>
                    )}
                  </td>
                  {p.field && <td><VerdictTag def={VERDICT[r.field_verdict]} /></td>}
                  <td className="num">{r.n_fields}</td>
                  <td><VerdictBar small defs={VERDICTS} counts={keyCounts(r)} title={`${r.n_fields} breaking fields`} /></td>
                  <td><VerdictTag def={KEY_VERDICT[r.key_verdict]} /></td>
                </tr>,
                isOpen && (
                  <tr key={`${r.key_id}-d`} className="expanded-row">
                    <td colSpan={p.field ? 9 : 8}><KeyDetail date={date} keyId={r.key_id} origin={p.field} /></td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      )}
      {rows.length > 20 && pager}
    </>
  );
}
