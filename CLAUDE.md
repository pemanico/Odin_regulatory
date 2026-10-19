# CLAUDE.md — Contexto do projeto "EMIR Breaks" (Agentic KPIs regulatórios)

> **Como usar este ficheiro**
> - Qualquer assistente (Claude do banco, Claude Code, ou outro) deve **ler este ficheiro antes de qualquer trabalho**.
> - No fim de cada sessão de trabalho, **atualizar** as secções "Estado atual", "Registo de decisões" e "Questões em aberto".
> - **Nunca colocar dados reais neste ficheiro** (UTIs, valores, nomes de contrapartes). Só estrutura, decisões e métricas agregadas.
> - Última atualização: 2026-10-19 (teste de fumo DuckDB no escritório + primeiro build com dados reais)

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
- **O identificador do trade vem em `UTI` ou em `PROPRIETARY`**, nunca nos dois (confirmado em 12/10: 489.446 linhas só com `PROPRIETARY`, 0 com ambos, 0 sem nenhum). A coluna lógica `uti` é `COALESCE(NULLIF(TRIM(UTI),''), NULLIF(TRIM(PROPRIETARY),''))` (config `columns.uti_alt`).
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
- ~~**Duplicação grave:**~~ **Desmentido em 2026-10-19 (ver 4.1):** era a chave errada (UTI vs PROPRIETARY), não duplicação. Texto original: algumas positions têm ~127 linhas por campo no mesmo dia (ex.: 2.667 linhas para 21 campos distintos). As contagens brutas estão inflacionadas. **Correção pedida à equipa (2026-10-16).** Causa provável a investigar: fan-out no join com o enriquecimento (TSR/BNPP) ou vários `RPT_ID`/`TXDTLS_ID` por UTI. A demo usa sempre a vista deduplicada.
- O Oracle da origem é anterior à 12.2: não suporta `LISTAGG ... ON OVERFLOW`.

### 4.1 Primeiro build com dados reais (business date 2026-10-12, 2026-10-19)
- **Ficheiros:** um Parquet por asset class e por business date (`matching_<co|cr|eq|fx|ir>_<yyyymmdd>.snappy.parquet`). Lidos juntos com `union_by_name`.
- **Schema:** `BUSINESS_DATE` é DATE. `REC_STAT_ID` é INTEGER (ordem numérica correta na dedup). `breaking_field` vem em **minúsculas** (indiferente em DuckDB; atenção em ClickHouse, que distingue maiúsculas).
- **Divergências de tipo entre asset classes** (colunas não mapeadas, sem impacto hoje): `BNPP_BODY_ID` DECIMAL(38,10) vs INTEGER (`eq`); `BNPP_PORTFOLIO_ID` DECIMAL (`fx`,`ir`) vs VARCHAR; `BNPP_PLATFORM_ID` ausente em `co` e `eq`. Os exports não saem com schema alinhado.
- **Colunas não previstas:** `BNPP_GLOBAL_BUSINESS_LINE`, `BNPP_SUB_BUSINESS_LINE`, `BNPP_METIER`, `BNPP_PLATFORM_ID`, `TOTAL_NUMBER_TRANSACTIONS_RPT`. Não existe `BNPP_COUNTERPARTY_CRDS_CODE_BNPP_BUSINESS_LINE`.
- **`data_quality` (12/10):** raw_rows 4.526.560; distinct_breaks 4.060.361; distinct_positions 276.153; conflicting_keys 5.132 (0,13%); dup_factor 1,11.
- **Leitura:**
  - A duplicação **não é grave no agregado** (~466 mil linhas em excesso, ~10%). As ~127 linhas/campo da secção 4 serão casos concentrados em poucas positions; a confirmar com a secção "positions com mais linhas brutas" do profile.
  - **Volume real maior do que o descrito:** 4,06M breaks distintos num só dia (~14,7 campos por position). Contradiz "~4,5M linhas em 12–15/10" (secção 4) e "1–2M linhas/dia" (secção 1).
  - **Top 20 deduplicado (12/10):** VALUATION_AMT, VENUE_OF_EXECUTION, VALUATION_CCY, UNIQUE_PRODUCT_ID, ISIN, CLEARING_OBLIGATION, PRODUCT_CLASSIFICATION, EXPIRATION_DATE, DELIVERY_TYPE, EFFECTIVE_DATE, NOTIONAL_AMT_LEG2, SETTLEMENT_DATE, NOTIONAL_AMT_LEG1, EXECUTION_TIMESTAMP, MASTER_AGREEMENT_TYPE, SPREAD_LEG2_TYP, NOTIONAL_AMT_LEG2_CCY, CONTRACT_TYPE, NOTIONAL_AMT_LEG1_CCY, FLOAT_RATE_LEG2_IDENTIFIER.
  - **Os 3 campos de package (`PCKG_TRANS_SPREAD*`) não estão no top 20 deduplicado** (o 20.º tem 66.427), mas estavam em 3.º–5.º no top 10 bruto da secção 4. Hipótese: o ranking bruto estava inflacionado pela duplicação e o fan-out concentra-se em trades de package. Confirmar com 13–15/10 carregados.
- **Saúde da chave (12/10, breaks distintos):** null_uti 23.247; null_cp1_lei 0; null_cp2_lei 0; same_lei 0; bnpp_null 311.682 (7,7%); **cpty_null 2.817.564 (69%)**.
  - A maioria dos breaks é a contraparte sem valor no campo. É provavelmente o maior cluster da demo (padrão "CPTY nulo") e o maior fator de redução breaks → decisões.
  - `same_lei` = 0 neste dia, apesar de ser um caso legítimo.
- **Positions com mais linhas brutas — todas têm `UTI` NULL.** As 10 primeiras somam 317.063 linhas brutas (≈68% do excesso de 466 mil), com 56–92 campos e **66 a 3.395 `BNPP_TRADE_NUMBER` distintos** cada.
  - Não são duplicados de uma position: são **milhares de trades diferentes sem UTI agrupados pelo mesmo par de LEIs**.
  - **A "duplicação grave" da secção 4 é, em grande parte, este artefacto**, não fan-out do enriquecimento.
  - **Impacto na dedup:** `ROW_NUMBER() OVER (PARTITION BY uti, cp1_lei, cp2_lei, breaking_field ...)` põe todos os UTIs NULL do mesmo par de LEIs na mesma partição. Os breaks de trades diferentes sem UTI são colapsados num só por campo. `distinct_breaks` fica **subcontado** (até ~300 mil breaks em 12/10) e parte das `conflicting_keys` serão estes casos, não conflitos reais. Ver questão 14.

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
| 2026-10-16 | UI da demo: visual médio e funcional (tabelas densas, filtros claros); polimento visual fica para depois. Cores num ficheiro de tema (tokens) com um verde provisório, a substituir pelos hexadecimais oficiais; logo como ficheiro local fora do Git |
| 2026-10-16 | `build:db` materializa `breaks_raw` e `breaks` como tabelas numa base DuckDB local (consultas repetidas rápidas) |
| 2026-10-19 | `config/local.json` com `business_line` → `BNPP_GLOBAL_BUSINESS_LINE` (o nível mais agregado da hierarquia Global > Sub > Métier). Provisório até confirmar a semântica com a equipa do data mart. Nenhuma alteração de código |
| 2026-10-19 | **Chave do break usa `COALESCE(UTI, PROPRIETARY)`** (`columns.uti_alt` em `config/default.json`, resolvido em `logicalSelect` de `src/db/model.js`). Antes, os trades sem UTI do mesmo par de LEIs colapsavam num só break por campo. Aprovado pelo Ordep |
| 2026-10-19 | Fixar a versão do `@duckdb/node-api` (`--save-exact`) e fazer commit do `package-lock.json`, em vez de `latest` |

---

## 6. Questões em aberto
1. **Mapeamento `BREAKING_FIELD` → campo do Excel de regras** (ex.: `VALUATION_AMT` → Table/Item ESMA). Os nomes são diferentes. Sem esta tabela de correspondência, as regras não se ligam aos breaks.
2. **Colunas do histórico de categorizações** e da tabela de reference IDs (código + descrição). Desbloqueia a métrica `reference_id_distribution` e o backtest.
3. Causa da duplicação e prazo da correção. Pista: `npm run profile` mostra `n_trade_numbers` por position; se for > 1, o fan-out vem do join com o enriquecimento TSR/BNPP. Com dados reais o `dup_factor` é 1,11 (ver 4.1): falta ver se está concentrado em trades de package.
4. Confirmar a hipótese dos grupos de campos correlacionados: `npm run profile -- --date <data>` com dados reais. **Bloqueado:** em 12/10 o profile parou depois da 1.ª secção (saúde da chave, positions duplicadas e combinações de campos não apareceram). Repetir sem redirecionar o output e ver o erro em stderr / `$LASTEXITCODE`.
5. Casos reais difíceis escolhidos pelos operacionais para a demo.
6. ~~Sistema operativo do PC do escritório.~~ **Fechado (2026-10-19):** Windows x64, Node v24.15.0.
7. Colunas físicas da chave: `REPORTING_COUNTERPARTY_LEI` e `OTHER_COUNTERPARTY_LEGAL_LEI` **existem** em todos os ficheiros com o mesmo tipo. Falta confirmar com os operacionais que é esta a chave que usam.
8. ~~Tipo de `BUSINESS_DATE`.~~ **Fechado (2026-10-19):** DATE; não é preciso `ODIN_BUSINESS_DATE_FORMAT`.
9. **Volume real:** 4,06M breaks distintos em 12/10. Confirmar com os operacionais se é o mesmo universo que veem na app (secção 1 fala de 1–2M/dia). É o primeiro número que vão contestar na demo.
10. **Chaves em conflito (123 em 12/10 com a chave corrigida; eram 5.132):** a dedup fica com o menor `REC_STAT_ID`. Confirmar se é o valor mais correto; afeta a verificação das regras BNPP vs CPTY nessas chaves.
11. **Semântica de `BNPP_GLOBAL_BUSINESS_LINE`** face à "business line do código CRDS da contraparte" prevista. Confirmar com a equipa do data mart antes de mostrar como dimensão.
12. Alinhar os tipos das colunas `BNPP_*` entre os exports por asset class (pedido à equipa; não bloqueia a demo).
13. Carregar 13–15/10 para validar `breaks_dod` e a hipótese dos campos de package.
14. ~~Chave do break com `UTI` NULL.~~ **Resolvido (2026-10-19):** o identificador vem em `PROPRIETARY` quando falta o `UTI`; chave = `COALESCE(UTI, PROPRIETARY)`. **Falta medir o efeito:** rebuild + profile de 12/10. Esperado: `dup_factor` ≈ 1,0, `distinct_breaks` perto de 4,5M e muito menos `conflicting_keys`. Se assim for, a correção de duplicação pedida à equipa a 2026-10-16 pode ser cancelada.
    - **Medido (12/10, depois da correção):** dup_factor 1,0; distinct_breaks ≈ 4,5M; null_uti 0; conflicting_keys 123 (eram 5.132). **Não há duplicação real a corrigir**: o pedido à equipa de 2026-10-16 pode ser cancelado.
    - Em aberto: o `PROPRIETARY` é o mesmo identificador que a contraparte reporta, ou um ID interno? Só afeta o rótulo na UI.
15. A secção "combinações de campos" do profile não aparece com dados reais (a execução termina antes). Diagnosticar com `$LASTEXITCODE`.

## 7. Estado atual
- **Feito (2026-10-16):** esqueleto do projeto.
  - Configuração com mapeamento de colunas.
  - Camada de dialeto e modelo lógico (`breaks_raw`, `breaks` deduplicada).
  - Semantic layer com as 6 métricas; `reference_id_distribution` está pendente do schema do histórico.
  - Log de auditoria (`logs/audit-*.jsonl`).
  - Gerador de dados sintéticos (grupos correlacionados, fan-out, conflitos, LEIs iguais).
  - Script de profiling.
  - Testes automáticos (`npm test`; 16 desde 2026-10-19); o SQL é validado contra SQLite com expectativas calculadas em JS.
- **Feito (2026-10-19):** validação no PC do escritório (Windows x64, Node v24.15.0).
  - `npm install` funciona depois de excluir o Artifactory interno do proxy (ver README, "Problemas conhecidos").
  - `npm test` 15/15; teste de fumo sintético completo sem erros. O adaptador `src/db/duckdb.js` funcionou sem alterações; a dedup e o profile detetam o fan-out, os conflitos e os LEIs iguais injetados.
  - Primeiro `build:db` com dados reais (12/10, 5 ficheiros, 13 s). Só foi preciso `config/local.json` para `business_line`. `data_quality` e `breaks_dod` OK (DoD sem comparação: só um dia carregado).
- **Feito (2026-10-19, tarde):** profile de 12/10 com saúde da chave e positions duplicadas. Descoberta: o excesso de linhas vem sobretudo de UTIs NULL, e a dedup colapsa-os (questão 14).
- **Feito (2026-10-19):** chave com `COALESCE(UTI, PROPRIETARY)`, validada com dados reais de 12/10: dup_factor 1,0, ~4,5M breaks distintos, 0 sem identificador, 123 chaves em conflito (reais); gerador sintético passa a ter ~10% de positions só com `PROPRIETARY`; teste novo (16 testes).
- **Pendente:** a secção de combinações de campos do profile não aparece (questão 15).
- **Próximos passos:**
  1. No escritório: descarregar o `main`, `npm run synthetic` (os Parquet sintéticos antigos não têm `PROPRIETARY`), `npm run build:db` com os dados reais e `npm run profile -- --date 2026-10-12`. Registar o efeito da nova chave (questão 14) e ver se a secção de combinações já aparece (questão 15).
  2. Fixar a versão do `@duckdb/node-api` e fazer commit do lock.
  3. Carregar 13–15/10; validar `breaks_dod` e a hipótese dos campos de package.
  4. Esclarecer com os operacionais o volume (questão 9) e a chave (questão 7).
  5. Receber o mapeamento `BREAKING_FIELD` → regras e o schema do histórico.
  6. Dias 3–5: compilar as regras ESMA dos 10 campos com mais volume, as assinaturas e o backtest.

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
