// Verdicts (per break and per Key). Colours validated on the dark surface (violet/orange/blue: CVD ΔE ≥ 26).
// Divergence and "no rules" are neutral on purpose: they do not identify a side. "No rules" carries a texture.
export const VERDICTS = [
  { id: 'both', label: 'Error on both sides', short: 'Both', color: 'var(--v-both)' },
  { id: 'bnpp_only', label: 'Error on the BNPP side', short: 'BNPP', color: 'var(--v-bnpp)' },
  { id: 'cpty_only', label: 'Error on the counterparty side', short: 'Counterparty', color: 'var(--v-cpty)' },
  { id: 'divergence', label: 'Divergence: both sides comply with the rules', short: 'Divergence', color: 'var(--v-div)' },
  { id: 'no_verifiable_rules', label: 'No verifiable ESMA rules', short: 'No rules', color: 'var(--v-none)', texture: true },
];
export const VERDICT = Object.fromEntries(VERDICTS.map((v) => [v.id, v]));

export const KEY_VERDICTS = [
  { id: 'mixed', label: 'Errors on both sides (in different fields or in the same one)', short: 'Mixed', color: 'var(--v-both)' },
  { id: 'bnpp', label: 'Errors on the BNPP side only', short: 'BNPP', color: 'var(--v-bnpp)' },
  { id: 'counterparty', label: 'Errors on the counterparty side only', short: 'Counterparty', color: 'var(--v-cpty)' },
  { id: 'unexplained', label: 'No field with the wrong side identified by the rules', short: 'Unexplained', color: 'var(--v-div)' },
];
export const KEY_VERDICT = Object.fromEntries(KEY_VERDICTS.map((v) => [v.id, v]));

/** Counts of a Key (n_* columns) in VERDICTS order. */
export const keyCounts = (r) => ({
  both: Number(r.n_both ?? 0),
  bnpp_only: Number(r.n_bnpp_only ?? 0),
  cpty_only: Number(r.n_cpty_only ?? 0),
  divergence: Number(r.n_divergence ?? 0),
  no_verifiable_rules: Number(r.n_no_rules ?? 0),
});
