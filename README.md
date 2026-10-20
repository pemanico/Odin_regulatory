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
ODIN_EXCLUDED_DATES=
```
Depois:
```bash
npm run build:db                           # cria data/odin.duckdb com breaks_raw e breaks (dedup)
npm run metric -- --list                   # métricas disponíveis
npm run metric -- top_fields --date 2026-10-12
npm run profile -- --date 2026-10-13
```

## Com dados reais
1. Copiar os Parquet da tabela de breaks para `data/breaks/`, com a estrutura do S3: `data/breaks/{asset_class}/{AAAA-MM-DD}/*.parquet`. São lidos todos juntos. Só copiar pastas com `_SUCCESS` (execução completa do pipeline); o `build:db` ainda não verifica isto.
2. No `.env`: `ODIN_BREAKS_GLOB=data/breaks/**/*.parquet` (o `**` apanha as subpastas). Se `BUSINESS_DATE` vier como texto `dd/mm/yyyy`, acrescentar também `ODIN_BUSINESS_DATE_FORMAT=%d/%m/%Y`.
3. Se os nomes das colunas forem diferentes, corrigir o mapeamento em `config/local.json` (mesma estrutura de `config/default.json`; só as chaves a alterar).
4. `npm run build:db` e depois `npm run profile -- --date <data>`. O profile esconde UTIs e LEIs por omissão; `--show-ids` mostra-os, só para consulta no ecrã (nunca colar esse output). **É o primeiro passo com dados reais:** confirma a duplicação, as chaves e os grupos de campos correlacionados.

## Estrutura de outros Parquet (ex.: ficheiro DTCC)
`npm run describe -- "<glob>"` mostra nº de ficheiros e linhas, colunas e tipos (separando `TP1_`/`TP2_` e os pares assimétricos) e linhas por business date / asset class. `--key COL1,COL2` mede a unicidade de uma chave candidata; `--all` lista também as colunas `TP1_`/`TP2_`. Não mostra valores: pode ser colado.

## Mapeamento `BREAKING_FIELD` → `TP1_`/`TP2_` (ficheiro DTCC)
Pré-requisito: `build:db` feito e um dia do ficheiro DTCC em `data/dtcc/{asset_class}/{data}/` (`ODIN_DTCC_GLOB`).
```bash
npm run map-fields -- --date 2026-10-15                 # top 20 campos
npm run map-fields -- --date 2026-10-15 --map CAMPO=SUFIXO --map ...   # mapeamento manual dos que não batem pelo nome
npm run map-fields -- --date 2026-10-15 --all-pairs     # valida os ~179 pares; CSV completo em data/reports/
npm run map-fields -- --date 2026-10-15 --explain VALUATION_CCY        # diferenças sem break por estado do relatório
```
Para cada campo: `pct_found` (breaks encontrados no DTCC pela chave), `pct_break_diff` (breaks com TP1 ≠ TP2; ≈100 = sufixo certo) e `pct_nobreak_diff` (transações sem break com TP1 ≠ TP2; ≈0 = comparação igual à do Spark). Campos sem par com o mesmo nome aparecem com candidatos, nunca mapeados automaticamente. Só contagens.

## Métricas (semantic layer)
| Métrica | O que responde |
|---|---|
| `breaks_by_field` | Breaks distintos por campo (e outras dimensões permitidas) |
| `breaks_dod` | Variação por campo face à business date anterior disponível |
| `persistence` | Breaks de D face a D-1: igual / alterado / novo / resolvido. Potencial de herança da categorização, **não** poupança |
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
npm run metric -- persistence --date 2026-10-15                       # total do dia
npm run metric -- persistence --date 2026-10-15 --dims breaking_field # por campo
npm run metric -- top_fields --date 2026-10-15 --sql      # só mostra o SQL gerado
```
**Datas excluídas:** as comparações entre dias (`breaks_dod`, `persistence`) saltam as datas de `excludedDates` em `config/default.json` (hoje `2026-10-12`, dia anómalo) e recusam-nas como data pedida. Para dados sintéticos, pôr `ODIN_EXCLUDED_DATES=` (vazio) no `.env`.

Cada execução fica registada em `logs/audit-<data>.jsonl` (pedido, SQL, nº de linhas, duração; sem dados).

## Problemas conhecidos
- **`Não foi possível carregar @duckdb/node-api`**: falta correr `npm install`.
- **Erro do driver DuckDB depois de instalado**: a API do `@duckdb/node-api` ainda está em evolução. O único ficheiro ligado ao driver é `src/db/duckdb.js`; ajustar aí (`DuckDBInstance.create`, `connect`, `runAndReadAll`, `getRowObjects`).
- **`npm install` dá `E403 Intranetbrowsingblocked`** no Artifactory interno (`artifactory.cib.echonet`): o npm está a mandar o pedido para a intranet pelo proxy de internet. Correção: `npm config set noproxy ".echonet,localhost,127.0.0.1"`. O aviso `Unknown user config "always-auth"` é inofensivo.
- **Windows / PowerShell — `.env` ignorado:** `echo ... > .env` grava em UTF-16. Criar com `Set-Content -Path .env -Value "..." -Encoding ascii` (acrescentar linhas com `Add-Content -Encoding ascii`).
- **Windows / PowerShell — `config/local.json` com erro de JSON:** no PowerShell 5.1, `-Encoding utf8` grava com BOM. Criar no VS Code ou com `[IO.File]::WriteAllText("$PWD\config\local.json", '<json>')`.
- **`Binder Error: Referenced column ... not found`** no `build:db`: o nome físico da coluna difere de `config/default.json`. Corrigir só essa chave em `config/local.json`. O DuckDB reporta uma coluna de cada vez; para ver o schema todo, correr `DESCRIBE SELECT * FROM read_parquet('<ficheiro>')`.
