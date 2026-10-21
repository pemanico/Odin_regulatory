#!/usr/bin/env node
// Demo server: API + built frontend (web/dist).
//
//   npm run build     # builds the frontend (once, or after changing web/)
//   npm start         # http://localhost:3001  (port: ODIN_PORT)
//   npm run dev       # development: API (with --watch) + Vite on http://localhost:5173
//
// The DuckDB database is opened READ_ONLY only during requests: `npm run rules` can run while the server is up.
// Listens on localhost only (no authentication): the demo runs on the presenter's PC.
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig, ROOT } from '../src/config.js';
import { openDuckDb } from '../src/db/duckdb.js';
import { createDbPool } from '../src/server/dbpool.js';
import { createApi } from '../src/server/api.js';
import { createApp } from '../src/server/app.js';

let express;
try {
  express = (await import('express')).default;
} catch (err) {
  console.error(`Could not load express. Run \`npm install\` first.\nDetail: ${err.message}`);
  process.exit(1);
}

const config = loadConfig();
if (!existsSync(config.source.dbPath)) {
  console.error(`DuckDB database not found: ${config.source.dbPath}. Run \`npm run build:db\` and \`npm run rules\`.`);
  process.exit(1);
}
const pool = createDbPool(() => openDuckDb(config.source.dbPath, { readOnly: true }));
const api = createApi(pool, { excludedDates: config.excludedDates });
const staticDir = resolve(ROOT, 'web/dist');
const app = createApp(express, api, {
  staticDir,
  log: (line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`),
});

const port = Number(process.env.ODIN_PORT || 3001);
const host = process.env.ODIN_HOST || '127.0.0.1';
app.listen(port, host, () => {
  console.log(`Odin Regulatory — API on http://${host === '127.0.0.1' ? 'localhost' : host}:${port}/api`);
  console.log(existsSync(resolve(staticDir, 'index.html'))
    ? `UI on http://localhost:${port}`
    : 'UI not built yet: `npm run build` (or `npm run dev` for development).');
});
