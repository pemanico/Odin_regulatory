#!/usr/bin/env node
// Servidor da demo: API + frontend compilado (web/dist).
//
//   npm run build     # compila o frontend (uma vez, ou depois de mudar web/)
//   npm start         # http://localhost:3001  (porta: ODIN_PORT)
//   npm run dev       # desenvolvimento: API (com --watch) + Vite em http://localhost:5173
//
// A base DuckDB é aberta em READ_ONLY só durante os pedidos: `npm run rules` pode correr com o servidor ligado.
// Só escuta em localhost (sem autenticação): a demo corre no PC de quem a apresenta.
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
  console.error(`Não foi possível carregar o express. Corre \`npm install\` primeiro.\nDetalhe: ${err.message}`);
  process.exit(1);
}

const config = loadConfig();
if (!existsSync(config.source.dbPath)) {
  console.error(`Base DuckDB não encontrada: ${config.source.dbPath}. Corre \`npm run build:db\` e \`npm run rules\`.`);
  process.exit(1);
}
const pool = createDbPool(() => openDuckDb(config.source.dbPath, { readOnly: true }));
const api = createApi(pool, { excludedDates: config.excludedDates });
const staticDir = resolve(ROOT, 'web/dist');
const app = createApp(express, api, { staticDir });

const port = Number(process.env.ODIN_PORT || 3001);
const host = process.env.ODIN_HOST || '127.0.0.1';
app.listen(port, host, () => {
  console.log(`Odin Regulatory — API em http://${host === '127.0.0.1' ? 'localhost' : host}:${port}/api`);
  console.log(existsSync(resolve(staticDir, 'index.html'))
    ? `UI em http://localhost:${port}`
    : 'UI ainda não compilada: `npm run build` (ou `npm run dev` para desenvolvimento).');
});
