# Odin Regulatory — EMIR Breaks

KPIs e triagem assistida de breaks de reconciliação EMIR (relatório DTCC), sobre data marts já processados por Spark.
Contexto completo, plano aprovado, decisões e questões em aberto: **[CLAUDE.md](CLAUDE.md)** (ler primeiro).

> Este repositório tem só código. **Nunca** commitar dados (Parquet, CSV, Excel, bases DuckDB): o `.gitignore` bloqueia-os.

## Requisitos
- Node.js ≥ 20 (os testes com SQLite precisam de Node ≥ 22.13; em versões anteriores são saltados)
- Acesso ao registo npm (direto ou via proxy interno) para instalar o `@duckdb/node-api`

## Arranque rápido (dados sintéticos)
```bash
npm install
npm test                                   # testes da semantic layer
npm run synthetic                          # gera data/synthetic/*.parquet (identificadores falsos SYNTH*)
```
Criar um ficheiro `.env` (copiar de `.env.example`) com:
```
ODIN_BREAKS_GLOB=data/synthetic/*.parquet
```
Depois:
```bash
npm run build:db                           # cria data/odin.duckdb com breaks_raw e breaks (dedup)
npm run metric -- --list                   # métricas disponíveis
npm run metric -- top_fields --date 2026-10-12
npm run profile -- --date 2026-10-13
```

## Com dados reais
1. Copiar os Parquet da tabela de breaks para `data/breaks/` (um ficheiro por business date).
2. No `.env`: `ODIN_BREAKS_GLOB=data/breaks/*.parquet`. Se `BUSINESS_DATE` vier como texto `dd/mm/yyyy`, acrescentar também `ODIN_BUSINESS_DATE_FORMAT=%d/%m/%Y`.
3. Se os nomes das colunas forem diferentes, corrigir o mapeamento em `config/local.json` (mesma estrutura de `config/default.json`; só as chaves a alterar).
4. `npm run build:db` e depois `npm run profile -- --date <data>`. **É o primeiro passo com dados reais:** confirma a duplicação, as chaves e os grupos de campos correlacionados.

## Métricas (semantic layer)
| Métrica | O que responde |
|---|---|
| `breaks_by_field` | Breaks distintos por campo (e outras dimensões permitidas) |
| `breaks_dod` | Variação por campo face à business date anterior disponível |
| `top_fields` | Top N de campos em break |
| `breaks_by_counterparty` | Breaks por LEI da contraparte |
| `reference_id_distribution` | *Pendente:* falta o schema do histórico de categorizações |
| `data_quality` | Linhas brutas vs. breaks distintos, fator de duplicação, chaves com valores em conflito |

Exemplos:
```bash
npm run metric -- breaks_by_field --from 2026-10-12 --to 2026-10-15 --dims business_date,breaking_field
npm run metric -- breaks_by_counterparty --date 2026-10-15 --filter breaking_field=VALUATION_AMT
npm run metric -- breaks_dod --date 2026-10-15 --filter asset_class=COMMODITY
npm run metric -- data_quality --from 2026-10-12 --to 2026-10-15
npm run metric -- top_fields --date 2026-10-15 --sql      # só mostra o SQL gerado
```
Cada execução fica registada em `logs/audit-<data>.jsonl` (pedido, SQL, nº de linhas, duração; sem dados).

## Problemas conhecidos
- **`Não foi possível carregar @duckdb/node-api`**: falta correr `npm install`.
- **Erro do driver DuckDB depois de instalado**: a API do `@duckdb/node-api` ainda está em evolução. O único ficheiro ligado ao driver é `src/db/duckdb.js`; ajustar aí (`DuckDBInstance.create`, `connect`, `runAndReadAll`, `getRowObjects`).
