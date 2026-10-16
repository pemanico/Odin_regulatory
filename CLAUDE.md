# CLAUDE.md — Contexto do projeto "EMIR Breaks" (Agentic KPIs regulatórios)

> **Como usar este ficheiro**
> - Qualquer assistente (Claude do banco, Claude Code, ou outro) deve **ler este ficheiro antes de qualquer trabalho**.
> - No fim de cada sessão de trabalho, **atualizar** as secções "Estado atual", "Registo de decisões" e "Questões em aberto".
> - **Nunca colocar dados reais neste ficheiro** (UTIs, valores, nomes de contrapartes). Só estrutura, decisões e métricas agregadas.
> - Última atualização: 2026-10-16 (esqueleto do código criado)

---

## 1. O que é o projeto

Aplicação web onde os utilizadores de negócio fazem pedidos por prompt e recebem KPIs, reports de análise ou tabelas, sobre **data marts regulatórios já processados por Spark**. A aplicação é separada por jurisdição (EMIR, MiFID, CFTC, SEC, Canadá, SFTR…) e terá uma parte de administração (a definir).

**Primeiro caso: EMIR, breaks de reconciliação/pairing** entre o que o BNPP reportou e o que a contraparte reportou, a partir do relatório de reconciliação recebido da DTCC.

### Problema de negócio
Os operacionais tratam ~1–2M linhas de breaks por dia, todas categorizadas em 1–2 dias, em massa. O fluxo manual atual é:
1. Pesquisar os breaks por business date na aplicação web.
2. Exportar para Excel.
3. Analisar `BREAKING_FIELD`, `BNPP_REPORTED` e `CPTY_REPORTED`.
4. Consultar o Excel de regras (ESMA + internas) para perceber qual lado está errado e porquê.
5. Categorizar na aplicação com um reference ID (taxonomia fechada); existe histórico desta categorização.
6. (Fora de âmbito) Corrigir e resubmeter.

**Onde perdem mais tempo:** KPIs, top 10 de breaking fields por business date, e identificar o erro tendo em conta as regras de negócio.

---

## 2. Plano de design APROVADO (2026-10-16) — demo em 15 dias

**Audiência da 1ª apresentação:** os operacionais que analisam os erros. Ganha-se com precisão e evidência, não com efeitos visuais.

### Âmbito
- **Dentro:** só EMIR; KPIs por prompt sobre métricas fechadas; top 10 de breaking fields por business date; identificação do erro com as regras; sugestão de reference ID com confiança.
- **Fora:** aprovação com escrita na app de produção, administração, RAG documental/OpenSearch, SQL livre, outras jurisdições.

### Arquitetura da demo
- **Motor:** DuckDB local a ler Parquet copiado para a máquina. Futuro: ClickHouse sobre S3 / tabelas nativas. O SQL deve usar um subconjunto standard (ex.: `COUNT(DISTINCT)`, não `uniq()`) para a migração mudar só a ligação.
- **Vista deduplicada:** grão = break distinto = `UTI + LEI CP1 + LEI CP2 + BREAKING_FIELD` (por business date).
- **Semantic layer, 6 métricas certificadas** (grão = break distinto):
  1. Breaks por `BREAKING_FIELD` e business date
  2. Variação face ao dia anterior
  3. Top N de campos
  4. Breaks por contraparte
  5. Distribuição de reference IDs (histórico)
  6. Linhas brutas vs. breaks distintos (KPI de qualidade de dados)
- **Motor de regras:** as regras ESMA de formato e domínio dos 10 campos com mais volume são compiladas em SQL e avaliadas **separadamente para o valor BNPP e para o valor da contraparte**. As regras internas ambíguas aparecem como texto, sem verificação automática.
- **Assinatura de um break** (base do clustering e da sugestão):
  - `BREAKING_FIELD`
  - padrão de preenchimento (BNPP nulo / CPTY nulo / ambos preenchidos)
  - valor BNPP válido pelas regras? (sim/não + código VR)
  - valor CPTY válido pelas regras? (sim/não + código VR)
  - par de valores (só para enums)
  - contraparte

  Hipótese adicional: o cluster útil pode ser o **conjunto de campos em break por position** (ver secção 4).
- **Sugestão:** para cada assinatura, o reference ID mais frequente no histórico, com a % de confiança. Abaixo de um limiar mínimo → "sem sugestão". **A validação é sempre humana (operacionais).** A concordância entre a sugestão e a decisão humana é o KPI de qualidade do motor.
- **Agente:** Claude através do gateway interno do banco, com tool calling. Tools: `list_metrics`, `query_metric(métrica, dimensões, filtros, data)`, `get_clusters(campo, data)`. **O LLM nunca vê linhas de dados**, só o schema, as definições de métricas e os resultados agregados. A evidência dos breaks é mostrada de forma determinística pela UI.
- **Backend:** Node.js (npm install funciona no escritório). Cliente DuckDB, chamadas ao gateway, log de auditoria (prompt → métrica → SQL).
- **Frontend:** React, 3 ecrãs:
  1. Prompt com resposta em tabela ou gráfico
  2. Top 10 de breaking fields por business date
  3. Drill-down campo → clusters → evidência (BNPP vs CPTY, regra VR, se cada lado a cumpre, sugestão + confiança)

  Tem um seletor de jurisdição, só com EMIR ativo.
- **Configuração:** nomes de tabelas, colunas, caminhos e endpoints ficam num ficheiro de configuração/`.env`, nunca hardcoded.

### Critérios de sucesso
- **Backtest:** % de sugestões corretas face às categorizações reais das últimas 2–4 semanas.
- **Fator de redução:** breaks → clusters (ex.: "1,1M → N decisões").
- **Casos reais:** 3–5 casos difíceis, escolhidos pelos operacionais, resolvidos ao vivo.

### Calendário (~11 dias úteis)
| Dias | Entrega |
|---|---|
| 1–2 | Vista dedup, estrutura confirmada, DuckDB a ler Parquet |
| 3–5 | Regras dos 10 campos, assinaturas, backtest |
| 6–8 | Backend, semantic layer, agente |
| 9–11 | UI (3 ecrãs) |
| 12–13 | Testes com casos dos operacionais |
| 14–15 | Margem e ensaio |

---

## 3. Dados (estrutura — sem dados reais)

### 3.1 Tabela de breaks (data mart, formato LONGO — 1 linha por break)
Origem Oracle: `T_AF_EMIR_RF_MATCHING` (acesso read-only via dblink). Cópia em Parquet para a demo.

| Grupo | Colunas |
|---|---|
| Break | `REC_STAT_ID`, `BREAKING_FIELD`, `BNPP_REPORTED`, `CPTY_REPORTED`, `RECONCILIATION_FLAG` |
| IDs do relatório DTCC | `RCNCLTNRPT_ID`, `TXDTLS_ID`, `RPT_ID`, `REFERENCE_DATE`, `FILENAME`, `BUSINESS_DATE` |
| Estado DTCC | `REC_CATEGORY`, `REPORTING_TYPE`, `PAIRING`, `RECONCILIATION`, `VALUATION_RECONCILIATION`, `REVIVED`, `FURTHER_MODIFICATION`, `TOTAL_NUMBER_TRANSACTIONS`, `RPT` |
| Partes | `REPORTING_COUNTERPARTY_LEI`, `OTHER_COUNTERPARTY_LEGAL_LEI`, `REPORT_SUBMITTING_ENTITY`, `ENTITY_RESP_FOR_REPORT`, `PROPRIETARY` |
| Trade | `UTI`, `C_PRIMARY_ASSET_CLASS`, `MATCHIG_MSK` |
| Booking interno (TSR) | `TSR_BODY_ID`, `TSR_EXECUTION_TIMESTAMP`, `TSR_MATURITY_DATE_UNDERLYING`, `TSR_NOTIONAL_AMOUNT_LEG1/LEG2`, `TSR_NOTIONAL_CURRENCY_1/2`, `TSR_EXCHANGE_RATE_1`, `TSR_FORWARD_EXCHANGE_RATE`, `TSR_CONTRACT_TYPE` |
| Enriquecimento BNPP | `BNPP_PORTFOLIO_ID`, `BNPP_BODY_ID`, `BNPP_REP_BEHALF_CODE_NAME`, `BNPP_EMIR_CLR_TSKLD_NAME`, `BNPP_EMIR_STATUS_NAME`, `BNPP_TRADE_NUMBER`, `BNPP_COUNTERPARTY_CRDS_CODE`, `BNPP_COUNTERPARTY_CRDS_CODE_BNPP_BUSINESS_LINE`, `BNPP_ACTIVITY_L1..L4` |

Notas:
- **Chave do break:** `UTI + LEI CP1 + LEI CP2 + BREAKING_FIELD` (+ `BUSINESS_DATE`). Os dois LEIs **podem ser iguais** (caso legítimo).
- Um break existe quando o valor TP1 ≠ TP2. **Sinais e casas decimais já são normalizados no Spark.** Não há tolerâncias a modelar.
- Uma position pode ter vários breaks (um por campo).
- As colunas de enriquecimento (`BNPP_ACTIVITY_L1..L4`, business line, asset class, CRDS code) servem de dimensões para KPIs e clusters.

### 3.2 Relatório de reconciliação da DTCC (ficheiro recebido, formato LARGO)
Uma linha por transação, com pares de colunas `TP1_<campo>` / `TP2_<campo>` (TP1 = BNPP, TP2 = contraparte) para centenas de campos EMIR REFIT, mais as colunas de estado (`RCNCLTNRPT_ID`, `TXDTLS_ID`, `REC_CATEGORY`, `PAIRING_RECONCILIATION`, `VALUATION_RECONCILIATION`, LEIs, `FILENAME`, `C_PRIMARY_ASSET_CLASS`, `BUSINESS_DATE`).
- O nome dos sufixos nem sempre é simétrico (ex.: `TP1_..._LEG1` vs `TP2_..._LEG2`). **Não usar diretamente**: a tabela longa da 3.1 é a fonte da demo.

### 3.3 Excel de regras usado manualmente pelos operacionais
Ficheiro: `EMIR-Refit_Reconciliation status matching.xlsx`. Colunas: `Table`, `Item`, `Section`, `Field`, `Format`, `Conditions`, `Error codes`.
- As regras são as validation rules ESMA EMIR REFIT (códigos `EMIR-VR-xxxx-nn`) mais regras internas.
- Níveis de complexidade:
  1. formato/domínio
  2. condicionais entre campos
  3. dados de referência externos (GLEIF, à data do reporte)
  4. regras de estado/ciclo de vida por UTI (sequência de action types). **Estas não se verificam registo a registo.**
- **Na demo:** só os níveis 1 e 2 dos 10 campos com mais volume.

### 3.4 Histórico de categorizações
Existe em Parquet e em Exadata, ligado à chave do break **com os valores reportados** (permite reconstruir o contexto de cada decisão). Taxonomia fechada de reference IDs. **Colunas ainda por receber.**

---

## 4. Descobertas (análise exploratória de 2026-10-16)

- **Top 10 de `BREAKING_FIELD`** (12–15/10/2026, ~4,5M linhas brutas): VALUATION_AMT, VENUE_OF_EXECUTION, PCKG_TRANS_SPREAD_TYP, PCKG_TRANS_SPREAD_CCY, PCKG_TRANS_SPREAD, UNIQUE_PRODUCT_ID, ISIN, VALUATION_CCY, PRODUCT_CLASSIFICATION, CLEARING_OBLIGATION.
- **Grupos de campos correlacionados** (hipótese a confirmar):
  - package (SPREAD_TYP / SPREAD_CCY / SPREAD, contagens quase iguais);
  - produto (UPI / ISIN / CFI);
  - valuation (AMT / CCY).
- **Duplicação grave:** algumas positions têm ~127 linhas por campo no mesmo dia (ex.: 2.667 linhas para 21 campos distintos). As contagens brutas estão inflacionadas. **Correção pedida à equipa (2026-10-16).** Causa provável a investigar: fan-out no join com o enriquecimento (TSR/BNPP) ou vários `RPT_ID`/`TXDTLS_ID` por UTI. A demo usa sempre a vista deduplicada.
- O Oracle da origem é anterior à 12.2: não suporta `LISTAGG ... ON OVERFLOW`.

---

## 5. Registo de decisões
| Data | Decisão |
|---|---|
| 2026-10-16 | O OpenSearch, no futuro, serve de catálogo semântico + RAG documental; fora da demo |
| 2026-10-16 | Abordagem híbrida: semantic layer para KPIs recorrentes; SQL livre só no futuro, como fallback sinalizado |
| 2026-10-16 | O Spark já calcula os breaks; não há motor de regras de validação a construir, só verificação das regras por lado para explicar o break |
| 2026-10-16 | Classificar por padrões/clusters, nunca LLM por break (volume) |
| 2026-10-16 | Validação sempre humana (operacionais); sistema sugere com confiança |
| 2026-10-16 | LLM: Claude via gateway interno; o LLM não vê linhas de dados |
| 2026-10-16 | DuckDB local para a demo; npm install funciona no escritório |
| 2026-10-16 | Plano de design da demo aprovado |
| 2026-10-16 | Código em JavaScript ESM (Node ≥ 20), sem passo de build, para correr direto a partir de um zip |
| 2026-10-16 | Tudo o que é específico do motor SQL fica em `src/db/dialects.js`; as métricas usam só SQL standard |
| 2026-10-16 | Valores de filtros renderizados como literais validados e escapados (`src/semantic/literals.js`); identificadores só do catálogo. Funciona igual em DuckDB, ClickHouse e SQLite, sem depender da API de parâmetros do driver |
| 2026-10-16 | Dedup: em cada chave de break fica a linha com menor `REC_STAT_ID`; duplicados com valores diferentes não são escondidos, são contados em `data_quality.conflicting_keys` |
| 2026-10-16 | "Dia anterior" em `breaks_dod` = business date anterior **disponível nos dados**, não o dia de calendário anterior |
| 2026-10-16 | `build:db` materializa `breaks_raw` e `breaks` como tabelas numa base DuckDB local (consultas repetidas rápidas) |

---

## 6. Questões em aberto
1. **Mapeamento `BREAKING_FIELD` → campo do Excel de regras** (ex.: `VALUATION_AMT` → Table/Item ESMA). Os nomes são diferentes. Sem esta tabela de correspondência, as regras não se ligam aos breaks.
2. **Colunas do histórico de categorizações** e da tabela de reference IDs (código + descrição). Desbloqueia a métrica `reference_id_distribution` e o backtest.
3. Causa da duplicação e prazo da correção. Pista: `npm run profile` mostra `n_trade_numbers` por position; se for > 1, o fan-out vem do join com o enriquecimento TSR/BNPP.
4. Confirmar a hipótese dos grupos de campos correlacionados: `npm run profile -- --date <data>` com dados reais.
5. Casos reais difíceis escolhidos pelos operacionais para a demo.
6. Sistema operativo do PC do escritório (para o binário nativo do DuckDB).
7. **Confirmar as colunas físicas da chave**: assumido `REPORTING_COUNTERPARTY_LEI` (CP1) e `OTHER_COUNTERPARTY_LEGAL_LEI` (CP2) em `config/default.json`. Ajustar se a chave usada pelos operacionais for outra.
8. Tipo de `BUSINESS_DATE` no Parquet exportado (DATE ou texto `dd/mm/yyyy`?). Se for texto, definir `ODIN_BUSINESS_DATE_FORMAT=%d/%m/%Y`.

## 7. Estado atual
- **Feito (2026-10-16):** esqueleto do projeto.
  - Configuração com mapeamento de colunas.
  - Camada de dialeto e modelo lógico (`breaks_raw`, `breaks` deduplicada).
  - Semantic layer com as 6 métricas; `reference_id_distribution` está pendente do schema do histórico.
  - Log de auditoria (`logs/audit-*.jsonl`).
  - Gerador de dados sintéticos (grupos correlacionados, fan-out, conflitos, LEIs iguais).
  - Script de profiling.
  - 15 testes automáticos (`npm test`); o SQL é validado contra SQLite com expectativas calculadas em JS.
- **Ainda não validado em DuckDB real:** o ambiente onde o código foi escrito não tinha acesso ao registo npm. O primeiro `npm install` + `npm run synthetic` + `npm run build:db` + `npm run metric -- top_fields --date 2026-10-12` é o teste de fumo. O adaptador em `src/db/duckdb.js` é o único ponto a ajustar se a API do driver diferir.
- **Próximos passos:**
  1. Teste de fumo DuckDB com dados sintéticos e depois reais (`npm run profile`).
  2. Receber o mapeamento `BREAKING_FIELD` → regras e o schema do histórico.
  3. Dias 3–5: compilar as regras ESMA dos 10 campos com mais volume, as assinaturas e o backtest.

## 8. Estrutura do repositório
```
config/default.json        mapeamento colunas físicas -> lógicas, caminhos (override: config/local.json, .env)
src/config.js              carrega config + .env
src/db/dialects.js         SQL específico de cada motor (duckdb, sqlite de testes)
src/db/model.js            modelo lógico, chave do break, breaks_raw/breaks (dedup)
src/db/duckdb.js           adaptador @duckdb/node-api (único ponto ligado ao driver)
src/semantic/catalog.js    6 métricas certificadas, dimensões e filtros permitidos
src/semantic/compiler.js   pedido estruturado -> SQL (whitelist + literais seguros)
src/semantic/runner.js     executa + auditoria
src/analysis/profile.js    queries exploratórias (combinações de campos, duplicação, chaves)
src/synthetic/generate.js  dados sintéticos (identificadores SYNTH*)
scripts/                   CLIs: synthetic, build-db, metric, profile
test/                      node:test
```
