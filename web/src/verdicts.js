// Veredictos (por break e por Key). Cores validadas no fundo escuro (violeta/laranja/azul: CVD ΔE ≥ 26).
// A divergência e o "sem regras" são neutros de propósito: não identificam um lado. "Sem regras" leva textura.
export const VERDICTS = [
  { id: 'ambos', label: 'Erro dos dois lados', short: 'Ambos', color: 'var(--v-both)' },
  { id: 'so_bnpp', label: 'Erro do lado BNPP', short: 'BNPP', color: 'var(--v-bnpp)' },
  { id: 'so_contraparte', label: 'Erro do lado da contraparte', short: 'Contraparte', color: 'var(--v-cpty)' },
  { id: 'divergencia', label: 'Divergência: os dois lados cumprem as regras', short: 'Divergência', color: 'var(--v-div)' },
  { id: 'sem_regras_verificaveis', label: 'Sem regras ESMA verificáveis', short: 'Sem regras', color: 'var(--v-none)', texture: true },
];
export const VERDICT = Object.fromEntries(VERDICTS.map((v) => [v.id, v]));

export const KEY_VERDICTS = [
  { id: 'misto', label: 'Erros dos dois lados (em campos diferentes ou no mesmo)', short: 'Misto', color: 'var(--v-both)' },
  { id: 'bnpp', label: 'Só erros do lado BNPP', short: 'BNPP', color: 'var(--v-bnpp)' },
  { id: 'contraparte', label: 'Só erros do lado da contraparte', short: 'Contraparte', color: 'var(--v-cpty)' },
  { id: 'sem_explicacao', label: 'Nenhum campo com o lado identificado pelas regras', short: 'Sem explicação', color: 'var(--v-div)' },
];
export const KEY_VERDICT = Object.fromEntries(KEY_VERDICTS.map((v) => [v.id, v]));

/** Contagens de uma Key (colunas n_*) na ordem dos VERDICTS. */
export const keyCounts = (r) => ({
  ambos: Number(r.n_ambos ?? 0),
  so_bnpp: Number(r.n_so_bnpp ?? 0),
  so_contraparte: Number(r.n_so_contraparte ?? 0),
  divergencia: Number(r.n_divergencia ?? 0),
  sem_regras_verificaveis: Number(r.n_sem_regras ?? 0),
});
