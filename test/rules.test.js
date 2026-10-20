import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileRule, compileAll, validateRules } from '../src/rules/compile.js';
import { loadRules, referencedItems } from '../src/rules/catalog.js';
import { insertViolationsSql, fieldRulesSql, insertVerdictSql, RESULTS_DDL, VERDICT_DDL, usedColumns, ruleInputSql, isSuspect, violationCountsSql, catalogTablesSql, DETAIL_DDL, insertDetailSql, VERDICT_TEXT } from '../src/rules/sql.js';
import { describeRule, fieldLabel } from '../src/rules/describe.js';
import { openSqlite, sqliteAvailable } from '../src/db/sqlite.js';
import { dialects } from '../src/db/dialects.js';
import { loadConfig } from '../src/config.js';

const skip = !(await sqliteAvailable()) && 'node:sqlite indisponível';

const FIELD_MAP = {
  items: {
    '1.1': { field: 'Reporting timestamp', common: 'REFERENCE_DATE' },
    '2.10': { field: 'Contract type', tp: ['CONTRACT_TYPE'] },
    '2.19': { field: 'Settlement currency 1', tp: ['SETTLEMENT_CCY_1'] },
    '2.21': { field: 'Valuation amount', tp: ['VALUATION_AMT'] },
    '2.42': { field: 'Execution timestamp', tp: ['EXECUTION_TIMESTAMP'] },
    '2.44': { field: 'Expiration date', tp: ['EXPIRATION_DATE'] },
    '2.47': { field: 'Delivery type', tp: ['DELIVERY_TYPE'] },
    '2.101': { field: 'Name of the floating rate of leg 2', tp: [] },
    '2.113': { field: 'Exchange rate 1', tp: ['EXCHANGE_RATE1'] },
    '2.114': { field: 'Forward exchange rate', tp: ['FWD_EXCHANGE_RATE'] },
  },
};
const SUFFIXES = ['CONTRACT_TYPE', 'SETTLEMENT_CCY_1', 'VALUATION_AMT', 'EXECUTION_TIMESTAMP', 'EXPIRATION_DATE', 'DELIVERY_TYPE', 'EXCHANGE_RATE1', 'FWD_EXCHANGE_RATE'];
const COLUMNS = new Map([['REFERENCE_DATE', 'VARCHAR'], ...SUFFIXES.flatMap((s) => [[`TP1_${s}`, 'VARCHAR'], [`TP2_${s}`, 'VARCHAR']])]);
const KEY = ['report_submitting_entity', 'cp1_lei', 'cp2_lei', 'uti', 'proprietary', 'asset_class'];

const R = (code, item, check, extra = {}) => ({ code, item, check, status: 'verificavel', ...extra });

/** Cria rule_input com uma linha por caso; valores TP1 e TP2 por sufixo. */
async function inputDb(rows) {
  const db = await openSqlite();
  const cols = [...KEY.map((k) => `k_${k}`), 'REFERENCE_DATE', ...SUFFIXES.flatMap((s) => [`TP1_${s}`, `TP2_${s}`])];
  await db.exec(`CREATE TABLE rule_input (${cols.map((c) => `"${c}" TEXT`).join(', ')})`);
  for (const [id, values] of rows.entries()) {
    const v = { k_uti: `U${id}`, k_report_submitting_entity: 'E', k_cp1_lei: 'A', k_cp2_lei: 'B', k_asset_class: 'CURR', ...values };
    const lit = (x) => (x == null ? 'NULL' : `'${String(x).replace(/'/g, "''")}'`);
    await db.exec(`INSERT INTO rule_input VALUES (${cols.map((c) => lit(v[c])).join(', ')})`);
  }
  return db;
}

/** Linhas (k_uti) que violam a regra num lado. */
async function violating(db, rule, side = 'BNPP') {
  const c = compileRule(rule, side, { fieldMap: FIELD_MAP, columns: COLUMNS, dialect: dialects.sqlite });
  assert.ok(c.sql, `devia compilar: ${c.notVerifiable}`);
  return (await db.all(`SELECT k_uti FROM rule_input WHERE ${c.sql} ORDER BY k_uti`)).map((r) => r.k_uti);
}

test('enum, required/blank condicionais e lados separados', { skip }, async () => {
  const db = await inputDb([
    { TP1_DELIVERY_TYPE: 'CASH', TP1_SETTLEMENT_CCY_1: 'EUR', TP2_DELIVERY_TYPE: 'XXXX' }, // U0: CPTY enum inválido
    { TP1_DELIVERY_TYPE: 'CASH', TP1_SETTLEMENT_CCY_1: null }, // U1: required_if CASH violado
    { TP1_DELIVERY_TYPE: 'PHYS', TP1_SETTLEMENT_CCY_1: 'EUR' }, // U2: blank_if PHYS violado
    { TP1_DELIVERY_TYPE: 'PHYS', TP1_SETTLEMENT_CCY_1: null }, // U3: ok
    { TP1_DELIVERY_TYPE: null, TP1_SETTLEMENT_CCY_1: null }, // U4: vazio não viola o enum
    { TP1_DELIVERY_TYPE: 'cash' }, // U5: enum é sensível a maiúsculas (valor reportado tem de ser exato)
  ]);
  const enumRule = R('EMIR-VR-2047-01', '2.47', { enum: ['CASH', 'PHYS', 'OPTL'] });
  assert.deepEqual(await violating(db, enumRule, 'BNPP'), ['U5']);
  assert.deepEqual(await violating(db, enumRule, 'CPTY'), ['U0']);
  assert.deepEqual(await violating(db, R('EMIR-VR-2019-01', '2.19', { required: true }, { when: { eq: ['2.47', 'CASH'] } })), ['U1']);
  assert.deepEqual(await violating(db, R('EMIR-VR-2019-05', '2.19', { blank: true }, { when: { eq: ['2.47', 'PHYS'] } })), ['U2']);
  await db.close();
});

test('decimal: dígitos, casas decimais, sinal e valores aceites', { skip }, async () => {
  const vals = ['1.12345', '1.123456', '-12.5', '1.', '1234567890123456789012345', '12345678901234567890123456', '0', 'abc', '9999999999999999999999999'];
  const db = await inputDb(vals.map((v) => ({ TP1_VALUATION_AMT: v, TP1_EXCHANGE_RATE1: v })));
  const any = R('EMIR-VR-2021-01', '2.21', { decimal: { digits: 25, decimals: 5, sign: 'any' } });
  assert.deepEqual(await violating(db, any), ['U1', 'U3', 'U5', 'U7']);
  const pos = R('EMIR-VR-2113-03', '2.113', { decimal: { digits: 18, decimals: 13, sign: 'positive' } });
  // positivo: falham o negativo (U2), o zero (U6), os que excedem 18 dígitos (U4, U5, U8), U1? (6 casas ≤ 13: ok), '1.' (U3), 'abc' (U7)
  assert.deepEqual(await violating(db, pos), ['U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8']);
  await db.close();
});

test('datas, timestamps e comparações (só quando os dois valores são válidos)', { skip }, async () => {
  const db = await inputDb([
    { TP1_EXPIRATION_DATE: '2020-01-01', TP1_EXECUTION_TIMESTAMP: '2021-05-05T10:00:00Z' }, // U0: expira antes da execução
    { TP1_EXPIRATION_DATE: '2030-01-01', TP1_EXECUTION_TIMESTAMP: '2021-05-05T10:00:00Z' }, // U1: ok
    { TP1_EXPIRATION_DATE: '01/01/2020', TP1_EXECUTION_TIMESTAMP: '2021-05-05T10:00:00Z' }, // U2: formato inválido -> sem comparação
    { TP1_EXPIRATION_DATE: '2013-12-31' }, // U3: antes de 2014-02-12
    { TP1_EXECUTION_TIMESTAMP: '2021-05-05 10:00:00' }, // U4: timestamp sem T/Z
  ]);
  assert.deepEqual(await violating(db, R('EMIR-VR-2044-02', '2.44', { compare: { op: '>=', ref: '2.42', as: 'date' } })), ['U0']);
  assert.deepEqual(await violating(db, R('EMIR-VR-2044-03', '2.44', { compare: { op: '>=', value: '2014-02-12', as: 'date' } })), ['U3']);
  assert.deepEqual(await violating(db, R('EMIR-VR-2044-01', '2.44', { date: true })), ['U2']);
  assert.deepEqual(await violating(db, R('EMIR-VR-2042-01', '2.42', { timestamp: true })), ['U4']);
  await db.close();
});

test('count_populated e check "all"', { skip }, async () => {
  const db = await inputDb([
    { TP1_EXCHANGE_RATE1: '1.1', TP1_FWD_EXCHANGE_RATE: '1.2', TP1_CONTRACT_TYPE: 'FORW' }, // U0: dois preenchidos em FORW
    { TP1_EXCHANGE_RATE1: null, TP1_FWD_EXCHANGE_RATE: null, TP1_CONTRACT_TYPE: 'FORW' }, // U1: nenhum preenchido
    { TP1_EXCHANGE_RATE1: '1.1', TP1_FWD_EXCHANGE_RATE: null, TP1_CONTRACT_TYPE: 'FORW' }, // U2: ok
  ]);
  const min1 = R('EMIR-VR-2113-01', '2.113', { count_populated: { refs: ['2.113', '2.114'], min: 1 } });
  const max1 = R('EMIR-VR-2113-02', '2.113', { count_populated: { refs: ['2.113', '2.114'], max: 1 } }, { when: { eq: ['2.10', 'FORW'] } });
  assert.deepEqual(await violating(db, min1), ['U1']);
  assert.deepEqual(await violating(db, max1), ['U0']);
  const both = R('EMIR-VR-2113-09', '2.113', { all: [{ required: true }, { decimal: { digits: 18, decimals: 13, sign: 'positive' } }] });
  assert.deepEqual(await violating(db, both), ['U1']);
  await db.close();
});

test('não verificável: campo sem colunas DTCC, coluna em falta, coluna tipada', () => {
  const ctx = { fieldMap: FIELD_MAP, columns: COLUMNS, dialect: dialects.duckdb };
  const dep = compileRule(R('EMIR-VR-2109-01', '2.21', { required: true }, { when: { populated: '2.101' } }), 'BNPP', ctx);
  assert.match(dep.notVerifiable, /2\.101/);
  // Colunas comuns (REFERENCE_DATE, LEIs, UTI) não são usadas: só campos TP1_/TP2_.
  const common = compileRule(R('EMIR-VR-2028-03', '2.44', { compare: { op: '<=', ref: '1.1', as: 'date' } }), 'BNPP', ctx);
  assert.match(common.notVerifiable, /coluna comum/);
  const missing = new Map([...COLUMNS].filter(([k]) => k !== 'TP2_VALUATION_AMT'));
  const r = R('EMIR-VR-2021-01', '2.21', { decimal: { digits: 25, decimals: 5 } });
  assert.ok(compileRule(r, 'BNPP', { ...ctx, columns: missing }).sql);
  assert.match(compileRule(r, 'CPTY', { ...ctx, columns: missing }).notVerifiable, /TP2_VALUATION_AMT/);
  const typed = new Map([...COLUMNS, ['TP1_VALUATION_AMT', 'DATE']]);
  assert.match(compileRule(r, 'BNPP', { ...ctx, columns: typed }).notVerifiable, /tipada/);
  // decimal numa coluna numérica: verifica sinal e grandeza (não o formato)
  const dbl = compileRule(r, 'BNPP', { ...ctx, columns: new Map([...COLUMNS, ['TP1_VALUATION_AMT', 'DOUBLE']]) });
  assert.match(dbl.sql, /ABS\("TP1_VALUATION_AMT"\) < 1e25/);
  // enum numa coluna tipada continua verificável (compara o valor, não o formato)
  assert.ok(compileRule(R('EMIR-VR-2047-01', '2.47', { enum: ['CASH'] }), 'BNPP', { ...ctx, columns: new Map([...COLUMNS, ['TP1_DELIVERY_TYPE', 'ENUM']]) }).sql);
});

test('validateRules rejeita códigos, checks e estados inválidos', () => {
  const ok = { rules: [R('EMIR-VR-2047-01', '2.47', { enum: ['CASH'] })] };
  assert.doesNotThrow(() => validateRules(ok, FIELD_MAP));
  assert.throws(() => validateRules({ rules: [R('VR-1', '2.47', { enum: [] })] }, FIELD_MAP), /código inválido/);
  assert.throws(() => validateRules({ rules: [R('EMIR-VR-2047-01', '9.99', { enum: [] })] }, FIELD_MAP), /item desconhecido/);
  assert.throws(() => validateRules({ rules: [R('EMIR-VR-2047-01', '2.47', { foo: 1 })] }, FIELD_MAP), /check inválido/);
  assert.throws(() => validateRules({ rules: [R('EMIR-VR-2047-01', '2.47', { enum: [] }, { status: 'parcial' })] }, FIELD_MAP), /nota/);
  assert.throws(() => validateRules({ rules: [ok.rules[0], ok.rules[0]] }, FIELD_MAP), /repetido/);
  assert.throws(() => validateRules({ rules: [R('EMIR-VR-2101-01', '2.101', { required: true })] }, FIELD_MAP), /não tem colunas TP1_\/TP2_/);
  assert.throws(() => validateRules({ rules: [R('EMIR-VR-1001-01', '1.1', { required: true })] }, FIELD_MAP), /não tem colunas TP1_\/TP2_/);
});

test('fluxo completo: violações por lado -> veredicto por break', { skip }, async () => {
  const db = await inputDb([
    { TP1_DELIVERY_TYPE: 'XXXX', TP2_DELIVERY_TYPE: 'CASH' }, // U0: só BNPP
    { TP1_DELIVERY_TYPE: 'CASH', TP2_DELIVERY_TYPE: 'YYYY' }, // U1: só contraparte
    { TP1_DELIVERY_TYPE: 'XXXX', TP2_DELIVERY_TYPE: 'YYYY' }, // U2: ambos
    { TP1_DELIVERY_TYPE: 'CASH', TP2_DELIVERY_TYPE: 'PHYS' }, // U3: divergência
    { TP1_VALUATION_AMT: '1', TP2_VALUATION_AMT: '2', TP1_DELIVERY_TYPE: 'ZZZZ' }, // U4: campo sem regras; DELIVERY_TYPE inválido mas sem break nesse campo
  ]);
  await db.exec(`CREATE TABLE breaks (business_date TEXT, ${KEY.map((k) => `${k} TEXT`).join(', ')}, breaking_field TEXT)`);
  for (const [u, f] of [['U0', 'delivery_type'], ['U1', 'DELIVERY_TYPE'], ['U2', 'DELIVERY_TYPE'], ['U3', 'DELIVERY_TYPE'], ['U4', 'VALUATION_AMT']]) {
    await db.exec(`INSERT INTO breaks VALUES ('2026-10-15', 'E', 'A', 'B', '${u}', NULL, 'CURR', '${f}')`);
  }
  const rulesDoc = { version: 't1', rules: [R('EMIR-VR-2047-01', '2.47', { enum: ['CASH', 'PHYS', 'OPTL'] })] };
  const compiled = compileAll(rulesDoc, { fieldMap: FIELD_MAP, columns: COLUMNS, dialect: dialects.sqlite });
  await db.exec(RESULTS_DDL);
  await db.exec(VERDICT_DDL);
  for (const c of compiled) for (const [side, s] of Object.entries(c.sides)) await db.exec(insertViolationsSql('2026-10-15', c, side, s.sql, 't1'));
  await db.exec(fieldRulesSql(compiled));
  await db.exec(insertVerdictSql('2026-10-15', db.dialect, 't1'));
  const rows = await db.all('SELECT uti, breaking_field, verdict, bnpp_codes, cpty_codes FROM break_verdict ORDER BY uti');
  assert.deepEqual(rows.map((r) => [r.uti, r.verdict]), [
    ['U0', 'so_bnpp'], ['U1', 'so_contraparte'], ['U2', 'ambos'], ['U3', 'divergencia'], ['U4', 'sem_regras_verificaveis'],
  ]);
  assert.equal(rows[0].breaking_field, 'DELIVERY_TYPE', 'campo em minúsculas no data mart liga à regra');
  assert.equal(rows[0].bnpp_codes, 'EMIR-VR-2047-01');
  assert.equal(rows[0].cpty_codes, null);
  assert.deepEqual(usedColumns(compiled), ['TP1_DELIVERY_TYPE', 'TP2_DELIVERY_TYPE']);
  // Âmbito: só os breaks do data mart. U4 tem DELIVERY_TYPE inválido mas não tem break nesse campo: não é registado.
  const counts = Object.fromEntries((await db.all(violationCountsSql('2026-10-15'))).map((r) => [r.side, Number(r.n)]));
  assert.deepEqual(counts, { BNPP: 2, CPTY: 2 });
  const [u4] = await db.all("SELECT COUNT(*) AS n FROM rule_results WHERE uti = 'U4'");
  assert.equal(Number(u4.n), 0);

  // Detalhe para os operacionais: campo ESMA, valores TP1/TP2 do campo em break, veredicto e erro em texto.
  for (const sql of catalogTablesSql(compiled, FIELD_MAP, describeRule, fieldLabel)) await db.exec(sql);
  await db.exec(DETAIL_DDL);
  await db.exec(insertDetailSql('2026-10-15', db.dialect, ['DELIVERY_TYPE', 'VALUATION_AMT'], 't1'));
  const det = await db.all('SELECT uti, campo, valor_bnpp, valor_other_cpty, veredicto, erro_bnpp, erro_other_cpty FROM break_detail ORDER BY uti');
  assert.deepEqual(det[0], {
    uti: 'U0', campo: '2.47 Delivery type', valor_bnpp: 'XXXX', valor_other_cpty: 'CASH', veredicto: VERDICT_TEXT.so_bnpp,
    erro_bnpp: "This field shall contain one of 'CASH', 'PHYS', 'OPTL'", erro_other_cpty: null,
  });
  assert.equal(det[3].veredicto, VERDICT_TEXT.divergencia);
  // Métrica certificada sobre break_verdict
  const { runMetric } = await import('../src/semantic/runner.js');
  const m = await runMetric(db, { metric: 'rule_verdict', filters: [{ dimension: 'business_date', op: 'eq', value: '2026-10-15' }] }, { audit: false });
  assert.deepEqual(Object.fromEntries(m.rows.map((r) => [r.verdict, Number(r.n_breaks)])),
    { so_bnpp: 1, so_contraparte: 1, ambos: 1, divergencia: 1, sem_regras_verificaveis: 1 });
  assert.deepEqual([det[4].campo, det[4].valor_bnpp, det[4].valor_other_cpty], ['2.21 Valuation amount', '1', '2']);
  await db.close();
});

test('ruleInputSql: só colunas usadas e semi-join com os breaks', () => {
  const sql = ruleInputSql(loadConfig(), dialects.duckdb, 'src', '2026-10-15', { columns: ['TP1_DELIVERY_TYPE'] });
  assert.match(sql, /s\."TP1_DELIVERY_TYPE"/);
  assert.doesNotMatch(sql, /s\.\*/);
  assert.match(sql, /JOIN \(SELECT DISTINCT report_submitting_entity/);
});

test('config real: regras válidas, referências resolvidas e compiláveis com todas as colunas TP', () => {
  const { fieldMap, rulesDoc } = loadRules();
  assert.equal(rulesDoc.rules.length, 274, 'códigos VR dos 128 campos com TP1_/TP2_ (passo 3)');
  assert.ok(rulesDoc.rules.every((r) => fieldMap.items[r.item].tp?.length), 'só campos com colunas TP');
  for (const r of rulesDoc.rules) for (const i of referencedItems(r)) assert.ok(fieldMap.items[i], `${r.code}: ${i}`);
  const cols = new Map();
  for (const e of Object.values(fieldMap.items)) {
    for (const t of e.tp ?? []) { cols.set(`TP1_${t}`, 'VARCHAR'); cols.set(`TP2_${t}`, 'VARCHAR'); }
    if (e.common) cols.set(e.common, 'VARCHAR');
  }
  const compiled = compileAll(rulesDoc, { fieldMap, columns: cols, dialect: dialects.duckdb });
  const unexpected = compiled.filter((c) => c.rule.status !== 'nao_verificavel' && Object.values(c.sides).some((s) => !s.sql));
  assert.deepEqual(unexpected.map((c) => c.rule.code), []);
  // Os 20 campos do topo têm regras no ficheiro.
  const targets = new Set(compiled.map((c) => c.suffix));
  for (const f of ['VALUATION_AMT', 'UNIQUE_PRODUCT_ID', 'VENUE_OF_EXECUTION', 'ISIN', 'VALUATION_CCY', 'SETTLEMENT_CCY_1', 'DELIVERY_TYPE',
    'PRODUCT_CLASSIFICATION', 'FLOAT_RATE_LEG2_IDENTIFIER', 'CLEARING_OBLIGATION', 'MASTER_AGREEMENT_VRSN_V', 'SETTLEMENT_DATE',
    'EXPIRATION_DATE', 'CONFIRMATION_TIMESTAMP', 'SETTLEMENT_CCY_2', 'EFFECTIVE_DATE', 'EXCHANGE_RATE1', 'CONFIRMED', 'NOTIONAL_AMT_LEG2']) {
    assert.ok(targets.has(f), f);
  }
});

test('isSuspect: só quando os dois lados violam acima do limiar', () => {
  assert.equal(isSuspect(40, 38), true);
  assert.equal(isSuspect(40, 0.2), false, 'erro de um só lado é um resultado real, não tradução errada');
  assert.equal(isSuspect(null, 50), false);
});

test('decimal em coluna DOUBLE: sinal e grandeza', { skip }, async () => {
  const db = await openSqlite();
  await db.exec('CREATE TABLE rule_input (k_uti TEXT, "TP1_NOTIONAL" REAL)');
  for (const [u, v] of [['U0', 10.5], ['U1', -1], ['U2', 1e30], ['U3', null], ['U4', 0]]) {
    await db.exec(`INSERT INTO rule_input VALUES ('${u}', ${v == null ? 'NULL' : v})`);
  }
  const fm = { items: { '2.64': { field: 'Notional amount of leg 2', tp: ['NOTIONAL'] } } };
  const c = compileRule(R('EMIR-VR-2064-01', '2.64', { decimal: { digits: 25, decimals: 5, sign: 'nonneg' } }), 'BNPP',
    { fieldMap: fm, columns: new Map([['TP1_NOTIONAL', 'DOUBLE']]), dialect: dialects.sqlite });
  const rows = (await db.all(`SELECT k_uti FROM rule_input WHERE ${c.sql} ORDER BY k_uti`)).map((r) => r.k_uti);
  assert.deepEqual(rows, ['U1', 'U2']);
  await db.close();
});

test('if / equals_any / not_equal', { skip }, async () => {
  const db = await inputDb([
    { TP1_CONTRACT_TYPE: 'OPTN', TP1_DELIVERY_TYPE: null }, // U0: if OPTN então obrigatório -> viola
    { TP1_CONTRACT_TYPE: 'SWAP', TP1_DELIVERY_TYPE: 'CASH' }, // U1: senão em branco -> viola
    { TP1_CONTRACT_TYPE: 'SWAP', TP1_DELIVERY_TYPE: null }, // U2: ok
    { TP1_CONTRACT_TYPE: 'OPTN', TP1_DELIVERY_TYPE: 'CASH' }, // U3: ok
  ]);
  const ifRule = R('EMIR-VR-2139-01', '2.47', { if: { when: { in: ['2.10', ['OPTN', 'SWPT']] }, then: { required: true }, else: { blank: true } } });
  assert.deepEqual(await violating(db, ifRule), ['U0', 'U1']);
  await db.close();

  const db2 = await inputDb([
    { TP1_SETTLEMENT_CCY_1: 'EUR', TP1_DELIVERY_TYPE: 'EUR', TP1_CONTRACT_TYPE: 'X' }, // U0: igual a 2.47 -> equals_any ok; not_equal viola
    { TP1_SETTLEMENT_CCY_1: 'EUR', TP1_DELIVERY_TYPE: 'USD', TP1_CONTRACT_TYPE: 'EUR' }, // U1: igual a 2.10 -> ok; not_equal ok
    { TP1_SETTLEMENT_CCY_1: 'EUR', TP1_DELIVERY_TYPE: 'USD', TP1_CONTRACT_TYPE: 'GBP' }, // U2: nenhum -> equals_any viola
    { TP1_SETTLEMENT_CCY_1: 'EUR', TP1_DELIVERY_TYPE: 'EUR', TP1_CONTRACT_TYPE: 'EUR' }, // U3: igual a 2.47 mas também a unless -> ok
  ]);
  assert.deepEqual(await violating(db2, R('EMIR-VR-2077-04', '2.19', { equals_any: ['2.47', '2.10'] })), ['U2']);
  assert.deepEqual(await violating(db2, R('EMIR-VR-2077-05', '2.19', { not_equal: { ref: '2.47', unless: '2.10' } })), ['U0']);
  await db2.close();
});

test('describeRule: erro de format/condition em texto, sem código', () => {
  const fm = FIELD_MAP;
  assert.equal(describeRule(R('EMIR-VR-2019-01', '2.19', { required: true }, { when: { eq: ['2.47', 'CASH'] } }), fm),
    "If Delivery type (2.47) = 'CASH': this field shall be populated");
  assert.equal(describeRule(R('EMIR-VR-2021-01', '2.21', { decimal: { digits: 25, decimals: 5, sign: 'any' } }), fm),
    'Format: value positive or negative, up to 25 numeric characters including up to 5 decimal places');
  assert.match(describeRule(R('EMIR-VR-2044-02', '2.44', { compare: { op: '>=', ref: '2.42', as: 'date' } }), fm), /Execution timestamp \(2\.42\)/);
  assert.equal(fieldLabel('delivery_type', fm), '2.47 Delivery type');
  assert.equal(fieldLabel('NAO_EXISTE', fm), 'NAO_EXISTE');
});
