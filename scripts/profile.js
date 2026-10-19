#!/usr/bin/env node
// Perfil de qualidade e padrões de uma business date. É a primeira coisa a correr com dados reais.
//
//   npm run profile -- --date 2026-10-15 [--combos 20] [--dups 10] [--show-ids]
//
// Por omissão NÃO mostra UTIs nem LEIs (o output pode ser colado em chats e documentos).
// --show-ids mostra-os, só para consulta no próprio ecrã.
import { loadConfig } from '../src/config.js';
import { parseArgs } from '../src/cli.js';
import { openDuckDb } from '../src/db/duckdb.js';
import { runMetric } from '../src/semantic/runner.js';
import { profileDate, redactIds } from '../src/analysis/profile.js';

const args = parseArgs(process.argv.slice(2));
if (!args.date) {
  console.error('Uso: npm run profile -- --date YYYY-MM-DD');
  process.exit(1);
}

const config = loadConfig();
const db = await openDuckDb(config.source.dbPath);
try {
  const dq = await runMetric(
    db,
    { metric: 'data_quality', filters: [{ dimension: 'business_date', op: 'eq', value: args.date }] },
    { excludedDates: config.excludedDates },
  );
  console.log('\n== Qualidade: linhas brutas vs. breaks distintos ==');
  console.table(dq.rows);

  const p = await profileDate(db, args.date, {
    combos: Number(args.combos ?? 20),
    dups: Number(args.dups ?? 10),
    excludedDates: config.excludedDates,
  });
  console.log('\n== Saúde da chave ==');
  console.table([p.keyHealth]);
  console.log('\n== Mudança de identificador face ao dia anterior (inflaciona "novo" e "resolvido" em persistence) ==');
  console.table([p.idChange]);
  console.log('\n== Positions com mais linhas brutas (n_trade_numbers > 1 sugere fan-out no enriquecimento) ==');
  if (!args['show-ids']) console.log('(UTIs e LEIs escondidos; usar --show-ids só para consulta no ecrã)');
  console.table(args['show-ids'] ? p.duplicated : redactIds(p.duplicated));
  console.log('\n== Combinações de campos em break por position ==');
  console.table(p.combinations);

  const total = dq.rows[0]?.distinct_positions ?? 0;
  if (total) {
    const pct = ((p.combosCoverPositions / total) * 100).toFixed(1);
    console.log(`\nAs ${p.combinations.length} combinações do topo cobrem ${p.combosCoverPositions} de ${total} positions (${pct}%).`);
  }
} catch (err) {
  console.error(`${err.name}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
