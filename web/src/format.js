// Formatação: separador de milhares com ponto e decimais com vírgula (como no Excel dos operacionais).
const int = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const dec = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const fmtInt = (n) => (n === null || n === undefined || n === '' ? '—' : int.format(Number(n)));
export const fmtPct = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? '—' : `${dec.format(Number(n))}%`);
export const fmtSigned = (n) => (n === null || n === undefined ? '—' : `${Number(n) > 0 ? '+' : ''}${int.format(Number(n))}`);
export const fmtSignedPct = (n) =>
  n === null || n === undefined || !Number.isFinite(Number(n)) ? '—' : `${Number(n) > 0 ? '+' : ''}${dec.format(Number(n))}%`;
export const pct = (part, total) => (Number(total) > 0 ? (Number(part) / Number(total)) * 100 : null);
/** 2026-10-15 -> 15/10/2026 */
export const fmtDate = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—');
export const shortDate = (d) => (d ? fmtDate(d).slice(0, 5) : '—');
export const fieldName = (f) => String(f ?? '').toUpperCase();
