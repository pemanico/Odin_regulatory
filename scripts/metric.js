#!/usr/bin/env node
// Corre uma métrica certificada a partir da linha de comandos.
//
//   npm run metric -- --list
//   npm run metric -- top_fields --date 2026-10-15
//   npm run metric -- breaks_by_field --from 2026-10-12 --to 2026-10-15 --dims business_date,breaking_field
//   npm run metric -- breaks_by_counterparty --date 2026-10-15 --filter breaking_field=VALUATION_AMT
//   npm run metric -- breaks_dod --date 2026-10-15
//   npm run metric -- persistence --date 2026-10-15 [--dims breaking_field]
//   npm run metric -- data_quality --from 2026-10-12 --to 2026-10-15
//   (acrescentar --sql para ver só o SQL, --json para saída JSON)
import { loadConfig } from '../src/config.js';
import { parseArgs } from '../src/cli.js';
import { describeCatalog } from '../src/semantic/catalog.js';
import { compileMetric } from '../src/semantic/compiler.js';
import { runMetric } from '../src/semantic/runner.js';
import { openDuckDb } from '../src/db/duckdb.js';

const args = parseArgs(process.argv.slice(2));

if (args.list || args._.length === 0) {
  const cat = describeCatalog();
  console.log(`Grão: ${cat.grain}\n`);
  for (const m of cat.metrics) {
    console.log(`- ${m.id}${m.available ? '' : '  [INDISPONÍVEL]'}\n    ${m.description}`);
    if (!m.available) console.log(`    Motivo: ${m.pendingReason}`);
  }
  console.log(`\nDimensões: ${Object.keys(cat.dimensions).join(', ')}`);
  process.exit(0);
}

const request = { metric: args._[0], filters: [] };
if (args.date) request.filters.push({ dimension: 'business_date', op: 'eq', value: args.date });
if (args.from || args.to) {
  if (!args.from || !args.to) {
    console.error('--from e --to têm de ser usados juntos');
    process.exit(1);
  }
  request.filters.push({ dimension: 'business_date', op: 'between', value: [args.from, args.to] });
}
for (const f of args.filter ?? []) {
  const eq = f.indexOf('=');
  if (eq < 1) {
    console.error(`Filtro inválido (esperado dim=valor ou dim=a,b): ${f}`);
    process.exit(1);
  }
  const dimension = f.slice(0, eq);
  const raw = f.slice(eq + 1);
  request.filters.push(
    raw.includes(',') ? { dimension, op: 'in', value: raw.split(',') } : { dimension, op: 'eq', value: raw },
  );
}
if (args.dims) request.dimensions = String(args.dims).split(',');
if (args.limit) request.limit = Number(args.limit);

try {
  const config = loadConfig();
  if (args.sql) {
    console.log(compileMetric(request, { excludedDates: config.excludedDates }).sql);
    process.exit(0);
  }
  const db = await openDuckDb(config.source.dbPath);
  try {
    const result = await runMetric(db, request, { source: 'cli', excludedDates: config.excludedDates });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${result.title} — ${result.rows.length} linha(s), ${result.ms} ms`);
      console.table(result.rows);
    }
  } finally {
    await db.close();
  }
} catch (err) {
  console.error(`${err.name}: ${err.message}`);
  process.exit(1);
}
