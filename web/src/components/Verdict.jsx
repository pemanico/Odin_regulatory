// Stacked verdict bar, tag and legend. Colour is never alone: tooltip, legend and numbers.
import { useTooltip } from './Tooltip.jsx';
import { fmtInt, fmtPct, pct } from '../format.js';

/**
 * @param defs    VERDICTS or KEY_VERDICTS
 * @param counts  { [id]: n }
 * @param onPick  (id) => void  (click on a segment)
 */
export function VerdictBar({ defs, counts, onPick, small = false, title }) {
  const tip = useTooltip();
  const total = defs.reduce((s, d) => s + Number(counts[d.id] ?? 0), 0);
  if (!total) return <span className="muted">—</span>;
  return (
    <div className={`vbar${small ? ' small' : ''}`} onMouseLeave={tip.hide}>
      {defs.map((d) => {
        const n = Number(counts[d.id] ?? 0);
        if (!n) return null;
        return (
          <div
            key={d.id}
            className={`seg-v${d.texture ? ' tex' : ''}`}
            style={{ flexGrow: n, flexBasis: 0, background: d.color }}
            onMouseMove={(e) =>
              tip.show(e, (
                <>
                  {title && <div className="t-title">{title}</div>}
                  <div className="t-row"><span>{d.label}</span></div>
                  <div className="t-row"><span className="mono">{fmtInt(n)}</span><span className="mono">{fmtPct(pct(n, total))}</span></div>
                  {onPick && <div className="t-row muted">click to see these breaks</div>}
                </>
              ))
            }
            onClick={onPick ? (e) => { e.stopPropagation(); tip.hide(); onPick(d.id); } : undefined}
          />
        );
      })}
    </div>
  );
}

export function VerdictTag({ def }) {
  if (!def) return <span className="muted">—</span>;
  return (
    <span className="vtag" title={def.label}>
      <span className={`dot${def.texture ? ' tex' : ''}`} style={{ background: def.color }} />
      {def.short}
    </span>
  );
}

export function Legend({ defs }) {
  return (
    <div className="legend">
      {defs.map((d) => (
        <span key={d.id} title={d.label}>
          <span className={`sw${d.texture ? ' tex' : ''}`} style={{ background: d.color }} />
          {d.short}
        </span>
      ))}
    </div>
  );
}
