#!/usr/bin/env node
// Quality and pattern profile of a business date. It is the first thing to run with real data.
//
//   npm run profile -- --date 2026-10-15 [--combos 20] [--dups 10] [--show-ids]
//
// By default it does NOT show UTIs or LEIs (the output may be pasted into chats and documents).
// --show-ids shows them, for on-screen use only.
import { loadConfig } from '../src/config.js';
import { parseArgs } from '../src/cli.js';
import { openDuckDb } from '../src/db/duckdb.js';
import { runMetric } from '../src/semantic/runner.js';
import { profileDate, redactIds } from '../src/analysis/profile.js';

const args = parseArgs(process.argv.slice(2));
if (!args.date) {
  console.error('Usage: npm run profile -- --date YYYY-MM-DD');
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
  console.log('\n== Quality: raw rows vs. distinct breaks ==');
  console.table(dq.rows);

  const p = await profileDate(db, args.date, {
    combos: Number(args.combos ?? 20),
    dups: Number(args.dups ?? 10),
    excludedDates: config.excludedDates,
  });
  console.log('\n== Key health ==');
  console.table([p.keyHealth]);
  console.log('\n== Identifier change vs. the previous day (inflates "new" and "resolved" in persistence) ==');
  console.table([p.idChange]);
  console.log('\n== Positions with the most raw rows (n_trade_numbers > 1 suggests fan-out in the enrichment) ==');
  if (!args['show-ids']) console.log('(UTIs and LEIs hidden; use --show-ids for on-screen use only)');
  console.table(args['show-ids'] ? p.duplicated : redactIds(p.duplicated));
  console.log('\n== Combinations of breaking fields per position ==');
  console.table(p.combinations);

  const total = dq.rows[0]?.distinct_positions ?? 0;
  if (total) {
    const pct = ((p.combosCoverPositions / total) * 100).toFixed(1);
    console.log(`\nThe top ${p.combinations.length} combinations cover ${p.combosCoverPositions} of ${total} positions (${pct}%).`);
  }
} catch (err) {
  console.error(`${err.name}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
