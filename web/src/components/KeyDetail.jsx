// Todos os breaks de uma transação (Key): campo ESMA, valor BNPP (TP1_<campo>), valor other cpty (TP2_<campo>),
// veredicto e a regra de format/condition violada em cada lado. O campo de origem do drill-down fica destacado.
import { useState } from 'react';
import { api } from '../api.js';
import { useAsync } from '../hooks.js';
import { VERDICT } from '../verdicts.js';
import { VerdictTag } from './Verdict.jsx';

const KEY_FIELDS = [
  ['report_submitting_entity', 'Submitting entity'],
  ['cp1_lei', 'LEI counterparty 1 (BNPP)'],
  ['cp2_lei', 'LEI other counterparty'],
  ['uti', 'UTI'],
  ['proprietary', 'Proprietary'],
  ['asset_class', 'Asset class'],
];

const Val = ({ v }) => (v === null || v === undefined || v === '' ? <span className="val null">vazio</span> : <span className="val">{v}</span>);

export function KeyDetail({ date, keyId, origin }) {
  const data = useAsync(() => api.key(keyId, date), [keyId, date]);
  const [copied, setCopied] = useState(false);
  if (data.loading) return <div className="keydetail muted">A carregar…</div>;
  if (data.error) return <div className="keydetail"><div className="error">{data.error.message}</div></div>;
  const { key, breaks } = data.data;

  // Chave de produção, separada por tabs, para colar na pesquisa da aplicação de produção.
  const copy = async () => {
    const text = KEY_FIELDS.map(([k]) => key[k] ?? '').join('\t');
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* sem permissão */ }
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
        <span className="secondary"><b className="mono">{breaks.length}</b> campos em break nesta transação</span>
        <button className="btn" onClick={copy}>{copied ? 'Copiado' : 'Copiar chave'}</button>
      </div>
      <table className="grid detail">
        <thead>
          <tr>
            <th>Campo (documento de regras)</th>
            <th>Valor BNPP · TP1</th>
            <th>Valor other cpty · TP2</th>
            <th>Veredicto</th>
            <th>Regra violada · BNPP</th>
            <th>Regra violada · other cpty</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((b) => (
            <tr key={b.breaking_field} className={b.breaking_field === origin ? 'origin' : undefined}>
              <td>
                <div>{b.campo}</div>
                <div className="field muted">{b.breaking_field}</div>
              </td>
              <td><Val v={b.valor_bnpp} /></td>
              <td><Val v={b.valor_other_cpty} /></td>
              <td title={b.verdict_text}><VerdictTag def={VERDICT[b.verdict]} /></td>
              <td className={`err${b.erro_bnpp ? ' has' : ''}`}>{b.erro_bnpp ?? <span className="muted">—</span>}</td>
              <td className={`err${b.erro_other_cpty ? ' has' : ''}`}>{b.erro_other_cpty ?? <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
