// All breaks of a transaction (Key): ESMA field, BNPP value (TP1_<field>), other cpty value (TP2_<field>),
// verdict and the format/condition rule violated on each side. The drill-down's source field is highlighted.
import { useState } from 'react';
import { api } from '../api.js';
import { useAsync } from '../hooks.js';
import { VERDICT } from '../verdicts.js';
import { VerdictTag } from './Verdict.jsx';

const KEY_FIELDS = [
  ['report_submitting_entity', 'Submitting entity'],
  ['cp1_lei', 'Counterparty 1 LEI (BNPP)'],
  ['cp2_lei', 'Other counterparty LEI'],
  ['uti', 'UTI'],
  ['proprietary', 'Proprietary'],
  ['asset_class', 'Asset class'],
];

const Val = ({ v }) => (v === null || v === undefined || v === '' ? <span className="val null">empty</span> : <span className="val">{v}</span>);

export function KeyDetail({ date, keyId, origin }) {
  const data = useAsync(() => api.key(keyId, date), [keyId, date]);
  const [copied, setCopied] = useState(false);
  if (data.loading) return <div className="keydetail muted">Loading…</div>;
  if (data.error) return <div className="keydetail"><div className="error">{data.error.message}</div></div>;
  const { key, breaks } = data.data;

  // Production key, tab-separated, to paste into the production application search.
  const copy = async () => {
    const text = KEY_FIELDS.map(([k]) => key[k] ?? '').join('\t');
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* no permission */ }
  };
  const sorted = [...breaks].sort((a, b) => (a.breaking_field === origin ? -1 : b.breaking_field === origin ? 1 : 0));
  return (
    <div className="keydetail">
      <div className="keyhead">
        {KEY_FIELDS.map(([k, label]) => (
          <div key={k}><span className="k">{label}</span><span className="mono">{key[k] ?? <span className="muted">—</span>}</span></div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <span className="secondary"><b className="mono">{breaks.length}</b> breaking fields in this transaction</span>
        <button className="btn" onClick={copy}>{copied ? 'Copied' : 'Copy key'}</button>
      </div>
      <table className="grid detail">
        <thead>
          <tr>
            <th>Field (rules document)</th>
            <th>BNPP value · TP1</th>
            <th>Other cpty value · TP2</th>
            <th>Verdict</th>
            <th>Rule violated · BNPP</th>
            <th>Rule violated · other cpty</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((b) => (
            <tr key={b.breaking_field} className={b.breaking_field === origin ? 'origin' : undefined}>
              <td>
                <div>{b.field_label}</div>
                <div className="field muted">{b.breaking_field}</div>
              </td>
              <td><Val v={b.bnpp_value} /></td>
              <td><Val v={b.other_cpty_value} /></td>
              <td title={b.verdict_text}><VerdictTag def={VERDICT[b.verdict]} /></td>
              <td className={`err${b.bnpp_error ? ' has' : ''}`}>{b.bnpp_error ?? <span className="muted">—</span>}</td>
              <td className={`err${b.other_cpty_error ? ' has' : ''}`}>{b.other_cpty_error ?? <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
