// Gerador de dados sintéticos com a forma da tabela de breaks (formato longo).
// Serve para desenvolver e testar SEM dados reais. Todos os identificadores são falsos
// (prefixo SYNTH) e os valores não correspondem a nenhuma operação real.
//
// Reproduz os padrões observados na análise exploratória (CLAUDE.md §4):
//  - grupos de campos correlacionados (package, produto, valuation);
//  - LEI CP1 = LEI CP2 em alguns casos;
//  - duplicação em fan-out (mesmo break repetido N vezes, trade_number diferente);
//  - duplicados com valores diferentes (conflitos);
//  - positions que se repetem de um dia para o outro.

/** PRNG determinístico (mulberry32) para resultados reproduzíveis. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ASSET_CLASSES = ['INTEREST_RATE', 'CREDIT', 'COMMODITY', 'EQUITY', 'FOREIGN_EXCHANGE'];
const BUSINESS_LINES = ['SYNTH_BL_MARKETS', 'SYNTH_BL_CLEARING', 'SYNTH_BL_FINANCING'];
const ACTIVITIES = [
  ['SYNTH GLOBAL MARKETS', 'FICC', 'RATES', 'SWAPS'],
  ['SYNTH GLOBAL MARKETS', 'FICC', 'COMMODITIES', 'ENERGY'],
  ['SYNTH GLOBAL MARKETS', 'EQUITY', 'DERIVATIVES', 'OTC'],
  ['SYNTH GLOBAL MARKETS', 'TRANSVERSAL', 'CLEARING', 'OTC CLIENT CLEARING'],
];
export const SYNTH_BNPP_LEI = 'SYNTHBNPP00000000001';

/** Lista de business dates (dias úteis) a partir de startDate. */
export function businessDates(startDate, days) {
  const out = [];
  const d = new Date(`${startDate}T00:00:00Z`);
  while (out.length < days) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function makeHelpers(rand) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const chance = (p) => rand() < p;
  const code = (n) => Array.from({ length: n }, () => ALNUM[Math.floor(rand() * ALNUM.length)]).join('');
  const amount = () => (Math.round(rand() * 2e7) / 100).toFixed(2);
  return { pick, chance, code, amount };
}

/** Gera os breaks de uma position (lista de { field, bnpp, cpty }). */
function positionBreaks(h) {
  const { pick, chance, code, amount, rand } = h;
  const out = [];
  if (chance(0.35)) {
    out.push({ field: 'VALUATION_AMT', bnpp: amount(), cpty: chance(0.1) ? null : amount() });
    if (chance(0.6)) out.push({ field: 'VALUATION_CCY', ...pick([{ bnpp: 'EUR', cpty: 'USD' }, { bnpp: 'USD', cpty: 'EUR' }, { bnpp: 'GBP', cpty: null }]) });
  }
  if (chance(0.3)) {
    out.push({
      field: 'VENUE_OF_EXECUTION',
      ...pick([{ bnpp: 'XOFF', cpty: 'XXXX' }, { bnpp: 'XXXX', cpty: 'XOFF' }, { bnpp: 'XOFF', cpty: null }, { bnpp: 'XSYN', cpty: 'XOFF' }]),
    });
  }
  if (chance(0.25)) {
    // Package: tipicamente um lado reporta os três campos e o outro não.
    const bnppSide = chance(0.1);
    const typ = pick(['PRIC', 'SPRD', 'PERC']);
    const ccy = pick(['EUR', 'USD']);
    const spread = (rand() * 100).toFixed(4);
    for (const [field, v] of [['PCKG_TRANS_SPREAD_TYP', typ], ['PCKG_TRANS_SPREAD_CCY', ccy], ['PCKG_TRANS_SPREAD', spread]]) {
      out.push({ field, bnpp: bnppSide ? v : null, cpty: bnppSide ? null : v });
    }
  }
  if (chance(0.3)) {
    // Produto: UPI diverge e arrasta ISIN e CFI com frequência.
    out.push({ field: 'UNIQUE_PRODUCT_ID', bnpp: `QZ${code(10)}`, cpty: `QZ${code(10)}` });
    if (chance(0.85)) out.push({ field: 'ISIN', bnpp: chance(0.5) ? `SY${code(10)}` : null, cpty: `SY${code(10)}` });
    if (chance(0.6)) out.push({ field: 'PRODUCT_CLASSIFICATION', bnpp: `S${code(5)}`, cpty: `S${code(5)}` });
  }
  if (chance(0.15)) {
    out.push({
      field: 'CLEARING_OBLIGATION',
      ...pick([{ bnpp: 'TRUE', cpty: 'FALSE' }, { bnpp: 'FALSE', cpty: 'UKWN' }, { bnpp: 'TRUE', cpty: 'UKWN' }]),
    });
  }
  if (chance(0.08)) {
    out.push(
      pick([
        { field: 'DELIVERY_TYPE', bnpp: 'OPTL', cpty: 'CASH' },
        { field: 'PRICE', bnpp: amount(), cpty: null },
        { field: 'CONFIRMED', bnpp: 'CONFIRMED', cpty: 'NON CONFIRMED' },
      ]),
    );
  }
  if (out.length === 0) out.push({ field: 'VALUATION_AMT', bnpp: amount(), cpty: amount() });
  return out;
}

function newPosition(h, n, cptyPool) {
  const { pick, chance, code } = h;
  // Distribuição enviesada: poucas contrapartes concentram muitos breaks (como na realidade).
  const idx = Math.floor(cptyPool.length * Math.pow(h.rand(), 3));
  const sameLei = chance(0.05);
  const activity = pick(ACTIVITIES);
  // ~10% das positions trazem o identificador em PROPRIETARY em vez de UTI (como nos dados reais).
  const proprietary = chance(0.1);
  return {
    uti: proprietary ? null : `SYNTHUTI${String(n).padStart(10, '0')}${code(6)}`,
    proprietary: proprietary ? `SYNTHPRP${String(n).padStart(10, '0')}${code(6)}` : null,
    cp1: SYNTH_BNPP_LEI,
    cp2: sameLei ? SYNTH_BNPP_LEI : cptyPool[idx],
    asset_class: pick(ASSET_CLASSES),
    business_line: pick(BUSINESS_LINES),
    activity,
    crds: `SYNTHCRDS${code(6)}`,
    trade: `SYNTHTRD${code(8)}`,
    breaks: positionBreaks(h),
  };
}

/**
 * Gera as linhas da tabela de breaks com os NOMES FÍSICOS da config (config.columns).
 * @returns {{ dates: string[], rows: object[] }}
 */
export function generateBreakRows({
  columns,
  startDate = '2026-10-12',
  days = 4,
  positionsPerDay = 5000,
  seed = 42,
  carryOverRate = 0.6,
  dupRate = 0.08,
  maxDup = 30,
  conflictRate = 0.01,
} = {}) {
  if (!columns) throw new Error('generateBreakRows: falta o mapeamento de colunas (config.columns)');
  const rand = prng(seed);
  const h = { ...makeHelpers(rand), rand };
  const cptyPool = Array.from({ length: 300 }, () => `SYNTH${h.code(15)}`);
  const dates = businessDates(startDate, days);

  const rows = [];
  let recStatId = 1;
  let positionSeq = 1;
  let previous = [];

  const col = (logical) => columns[logical];
  const emit = (date, p, b, overrides = {}) => {
    const row = {
      [col('rec_stat_id')]: recStatId++,
      [col('business_date')]: date,
      [col('uti')]: p.uti,
      [col('uti_alt')]: p.proprietary,
      [col('cp1_lei')]: p.cp1,
      [col('cp2_lei')]: p.cp2,
      [col('breaking_field')]: b.field,
      [col('bnpp_value')]: b.bnpp,
      [col('cpty_value')]: b.cpty,
      [col('asset_class')]: p.asset_class,
      [col('rec_category')]: 'REPORTING REQUIREMENT',
      [col('pairing')]: 'PARD',
      [col('reconciliation')]: 'NREC',
      [col('valuation_reconciliation')]: h.chance(0.5) ? 'RECO' : 'NOAP',
      [col('business_line')]: p.business_line,
      [col('activity_l1')]: p.activity[0],
      [col('activity_l2')]: p.activity[1],
      [col('activity_l3')]: p.activity[2],
      [col('activity_l4')]: p.activity[3],
      [col('cpty_crds_code')]: p.crds,
      [col('trade_number')]: p.trade,
      ...overrides,
    };
    delete row.undefined; // colunas lógicas sem mapeamento físico
    rows.push(row);
  };

  for (const date of dates) {
    const carried = previous.filter(() => h.chance(carryOverRate));
    const todays = [...carried];
    while (todays.length < positionsPerDay) todays.push(newPosition(h, positionSeq++, cptyPool));

    for (const p of todays) {
      for (const b of p.breaks) {
        emit(date, p, b);
        if (h.chance(dupRate)) {
          const copies = 1 + Math.floor(h.rand() * (maxDup - 1));
          for (let i = 0; i < copies; i++) emit(date, p, b, { [col('trade_number')]: `SYNTHTRD${h.code(8)}` });
        }
        if (h.chance(conflictRate)) emit(date, p, b, { [col('cpty_value')]: `${b.cpty ?? ''}X` });
      }
    }
    previous = todays;
  }
  return { dates, rows };
}

/** Serializa linhas para CSV (vazio = NULL). */
export function toCsv(rows, headers) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n') + '\n';
}
