#!/usr/bin/env node
// Estrutura de um conjunto de ficheiros Parquet, sem mostrar dados (só nomes, tipos e contagens).
// Pensado para ficheiros largos como o relatório da DTCC (centenas de colunas TP1_/TP2_).
//
//   npm run describe -- "data/dtcc/**/*.parquet"
//   npm run describe -- "data/dtcc/**/*.parquet" --all                  # lista também as colunas TP1_/TP2_
//   npm run describe -- "data/dtcc/**/*.parquet" --key UTI,PROPRIETARY  # unicidade de uma chave candidata
//   npm run describe -- "<glob>" --distinct COL1,COL2                    # nº de valores distintos e nulos por coluna
//   npm run describe -- "<glob>" --overlap COL_A,COL_B                   # nº de valores que aparecem nas duas colunas
//   npm run describe -- "<glob>" --values TP1_CONFIRMED,TP2_CONFIRMED     # contagem por valor de colunas de códigos
//       (recusa colunas com mais de 50 valores distintos: podem ser identificadores)
//
// O output pode ser colado em chats: não contém valores, só estrutura e agregados.
import fs from 'node:fs';
import { parseArgs } from '../src/cli.js';
import { openDuckDb } from '../src/db/duckdb.js';

const args = parseArgs(process.argv.slice(2));
const glob = args._[0];
if (!glob) {
  console.error('Uso: npm run describe -- "<glob dos parquet>" [--all] [--key COL1,COL2]');
  process.exit(1);
}
const files = fs.globSync ? fs.globSync(glob) : [];
console.log(`Ficheiros: ${files.length}`);
if (files.length === 0) process.exit(1);

const ident = (c) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c)) throw new Error(`Nome de coluna inválido: ${c}`);
  return `"${c}"`;
};
const src = `read_parquet('${glob.replace(/'/g, "''")}', union_by_name = true)`;
const db = await openDuckDb(':memory:');
try {
  const cols = await db.all(`DESCRIBE SELECT * FROM ${src}`);
  const names = cols.map((c) => c.column_name);
  const tp1 = cols.filter((c) => /^TP1_/i.test(c.column_name));
  const tp2 = cols.filter((c) => /^TP2_/i.test(c.column_name));
  const other = cols.filter((c) => !/^TP[12]_/i.test(c.column_name));

  const [{ n }] = await db.all(`SELECT COUNT(*) AS n FROM ${src}`);
  console.log(`Linhas: ${n}`);
  console.log(`Colunas: ${cols.length} (TP1_: ${tp1.length}, TP2_: ${tp2.length}, outras: ${other.length})`);

  console.log('\n== Colunas que não são TP1_/TP2_ ==');
  console.table(other.map((c) => ({ coluna: c.column_name, tipo: c.column_type })));

  // Pares assimétricos: TP1_x sem TP2_x correspondente (e vice-versa).
  const suffix = (c) => c.column_name.slice(4).toUpperCase();
  const s1 = new Set(tp1.map(suffix));
  const s2 = new Set(tp2.map(suffix));
  const only1 = [...s1].filter((x) => !s2.has(x)).sort();
  const only2 = [...s2].filter((x) => !s1.has(x)).sort();
  console.log(`\nPares TP1_/TP2_ com o mesmo sufixo: ${[...s1].filter((x) => s2.has(x)).length}`);
  console.log(`Só TP1_ (${only1.length}): ${only1.join(', ') || '-'}`);
  console.log(`Só TP2_ (${only2.length}): ${only2.join(', ') || '-'}`);
  if (args.all) {
    console.log('\n== Colunas TP1_/TP2_ ==');
    console.table([...tp1, ...tp2].map((c) => ({ coluna: c.column_name, tipo: c.column_type })));
  }

  // REFERENCE_DATE: data do relatório DTCC, para comparar com BUSINESS_DATE e com a pasta.
  for (const c of ['BUSINESS_DATE', 'REFERENCE_DATE', 'C_PRIMARY_ASSET_CLASS']) {
    if (!names.includes(c)) continue;
    console.log(`\n== Linhas por ${c} ==`);
    console.table(await db.all(`SELECT ${ident(c)} AS valor, COUNT(*) AS linhas FROM ${src} GROUP BY 1 ORDER BY 1`));
  }

  if (args.key) {
    const key = String(args.key).split(',').map((k) => k.trim());
    for (const k of key) if (!names.includes(k)) throw new Error(`Coluna da chave não existe: ${k}`);
    const keyExpr = key.map((k) => `COALESCE(CAST(${ident(k)} AS VARCHAR), '')`).join(` || '|' || `);
    const nulls = key.map((k) => `SUM(CASE WHEN ${ident(k)} IS NULL THEN 1 ELSE 0 END) AS null_${k}`).join(', ');
    const [r] = await db.all(`SELECT COUNT(*) AS linhas, COUNT(DISTINCT ${keyExpr}) AS chaves_distintas, ${nulls} FROM ${src}`);
    console.log(`\n== Chave candidata: ${key.join(' + ')} ==`);
    console.table([r]);
  }
  if (args.distinct) {
    const cs = String(args.distinct).split(',').map((k) => k.trim());
    const rows = [];
    for (const c of cs) {
      if (!names.includes(c)) throw new Error(`Coluna não existe: ${c}`);
      const [r] = await db.all(
        `SELECT COUNT(DISTINCT ${ident(c)}) AS distintos, SUM(CASE WHEN ${ident(c)} IS NULL THEN 1 ELSE 0 END) AS nulos FROM ${src}`,
      );
      rows.push({ coluna: c, ...r });
    }
    console.log('\n== Valores distintos por coluna ==');
    console.table(rows);
  }

  if (args.values) {
    const MAX = 50;
    for (const c of String(args.values).split(',').map((k) => k.trim())) {
      if (!names.includes(c)) throw new Error(`Coluna não existe: ${c}`);
      const [{ n }] = await db.all(`SELECT COUNT(DISTINCT ${ident(c)}) AS n FROM ${src}`);
      if (Number(n) > MAX) {
        console.log(`\n== ${c}: ${n} valores distintos (> ${MAX}) — não mostrado (pode conter identificadores) ==`);
        continue;
      }
      console.log(`\n== Valores de ${c} ==`);
      console.table(await db.all(`SELECT ${ident(c)} AS valor, COUNT(*) AS linhas FROM ${src} GROUP BY 1 ORDER BY 2 DESC`));
    }
  }

  if (args.overlap) {
    const [a, b] = String(args.overlap).split(',').map((k) => k.trim());
    for (const c of [a, b]) if (!c || !names.includes(c)) throw new Error(`--overlap exige duas colunas existentes: ${args.overlap}`);
    const [r] = await db.all(`SELECT
  (SELECT COUNT(DISTINCT ${ident(a)}) FROM ${src}) AS distintos_a,
  (SELECT COUNT(DISTINCT ${ident(b)}) FROM ${src}) AS distintos_b,
  (SELECT COUNT(*) FROM (SELECT DISTINCT ${ident(a)} AS v FROM ${src} WHERE ${ident(a)} IS NOT NULL
     INTERSECT SELECT DISTINCT ${ident(b)} FROM ${src} WHERE ${ident(b)} IS NOT NULL) i) AS em_ambas`);
    console.log(`\n== Sobreposição de valores: ${a} vs ${b} ==`);
    console.table([r]);
  }
} catch (err) {
  console.error(`${err.name}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
