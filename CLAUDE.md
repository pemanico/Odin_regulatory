# CLAUDE.md — Contexto do projeto "EMIR Breaks" (Agentic KPIs regulatórios)

> **Como usar este ficheiro**
> - Qualquer assistente (Claude do banco, Claude Code, ou outro) deve **ler este ficheiro antes de qualquer trabalho**.
> - No fim de cada sessão de trabalho, **atualizar** as secções "Estado atual", "Registo de decisões" e "Questões em aberto".
> - **Nunca colocar dados reais neste ficheiro** (UTIs, valores, nomes de contrapartes). Só estrutura, decisões e métricas agregadas.
> - Última atualização: 2026-10-20 (chave do break alinhada com a de produção)

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
- **Vista deduplicada:** grão = break distinto = **chave de produção** `REPORT_SUBMITTING_ENTITY + LEI CP1 + LEI CP2 + UTI + PROPRIETARY + C_PRIMARY_ASSET_CLASS + BREAKING_FIELD` (por business date; UTI e PROPRIETARY como colunas separadas, desde 2026-10-20).
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
  - padrão de preenchimento (BNPP nulo / CPTY nulo / ambos preenchidos) — ⚠️ **Corrigido em 2026-10-19 (ver 3.1.2):** tem de vir do ficheiro DTCC
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

### Critérios de sucesso (revistos em 2026-10-19: categorização adiada)
- ~~**Backtest:** % de sugestões corretas face às categorizações reais das últimas 2–4 semanas.~~ Adiado com a categorização.
- **Explicação pelas regras (substitui o backtest):** em X% dos breaks dos 10 campos, a ferramenta indica qual lado viola a regra ESMA. Medido numa amostra validada pelos operacionais.
- **Fator de redução:** breaks → grupos a decidir (persistência "igual" + clusters por assinatura; ex.: "2,3M → N decisões").
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
- **O identificador do trade vem em `UTI` ou em `PROPRIETARY`**, nunca nos dois (confirmado em 12/10: 489.446 linhas só com `PROPRIETARY`, 0 com ambos, 0 sem nenhum). Desde 2026-10-20 são **duas colunas lógicas separadas** (`uti`, `proprietary`; texto vazio = NULL), ambas na chave, como em produção e no ficheiro DTCC. Para mostrar/agregar um identificador único usa-se `tradeIdExpr()` = `COALESCE(uti, proprietary)`.
- Um break existe quando o valor TP1 ≠ TP2. **Os dois valores vêm do mesmo ficheiro DTCC → não há normalização a fazer do nosso lado** (Ordep, 2026-10-20; substitui a nota antiga "sinais e casas decimais normalizados no Spark"). A confirmar com `pct_nobreak_diff` ≈ 0 no `map-fields`: se não for, há tolerâncias no matching (DTCC ou Spark) que o motor tem de conhecer.
- Uma position pode ter vários breaks (um por campo).
- As colunas de enriquecimento (`BNPP_ACTIVITY_L1..L4`, business line, asset class, CRDS code) servem de dimensões para KPIs e clusters.

### 3.1.1 Localização dos Parquet em S3 (produção)
- Caminho: `s3://uk-prd-s3-v2-prd-odin-airflow/trusted/emir_refit/matching_folder/{asset_class}/{AAAA-MM-DD}/`.
- Em cada pasta há um ou mais `part-*.snappy.parquet` e o ficheiro de controlo `_SUCCESS` do pipeline.
- **Regras para a ingestão:**
  - Só ler pastas com `_SUCCESS`; uma pasta sem ele é uma execução incompleta.
  - Ler só `*.parquet`, porque os ficheiros de controlo não são dados.
  - A asset class e a data vêm das colunas `C_PRIMARY_ASSET_CLASS` e `BUSINESS_DATE`, não do nome da pasta.
- **Decisão pendente:** copiar para `data/breaks/` (a funcionar hoje) ou ler diretamente de S3 com a extensão `httpfs` do DuckDB. Depende de a extensão se instalar através do proxy, das credenciais AWS no PC e da autorização para ler produção a partir do desktop.

### 3.1.2 Correção (2026-10-19, Ordep): chave real e onde estão os valores
- **Chave usada em produção** para os breaks:
  `RANK() OVER (PARTITION BY BREAKING_FIELD, REPORTING_COUNTERPARTY_LEI, OTHER_COUNTERPARTY_LEGAL_LEI, REPORT_SUBMITTING_ENTITY, UTI, PROPRIETARY, C_PRIMARY_ASSET_CLASS ORDER BY rownum)`.
  A nossa chave tem menos colunas (sem `REPORT_SUBMITTING_ENTITY` nem `C_PRIMARY_ASSET_CLASS`). Como já não há duplicados com a chave mais estreita (questão 14), a contagem não muda; muda o join entre dias (persistência) se um destes campos mudar.
  Nota: `RANK() ... ORDER BY rownum` comporta-se como `ROW_NUMBER()` (rownum é único).
- **`BNPP_REPORTED` / `CPTY_REPORTED` NÃO são os valores do campo em break.** O data mart só diz **qual** campo está em break. Os valores de cada lado estão no **ficheiro da DTCC** (secção 3.2, colunas `TP1_<campo>` / `TP2_<campo>`). É aí que o utilizador valida o campo contra o documento de regras.
- **Consequências (a rever, nada implementado ainda):**
  1. Tudo o que interpretou `bnpp_null` / `cpty_null` como "esse lado não tem valor" está sem base: a leitura de 12/10 (70% cpty_null), o "13/10 destoa" (questão 22) e o alerta de qualidade proposto.
  2. A métrica `persistence` compara `bnpp_value` / `cpty_value` → o grupo "igual" vs "alterado" não mede o que foi aprovado. Só a parte de chave (novo / resolvido / continua) é válida.
  3. O "padrão de preenchimento" da assinatura do break não pode vir destas colunas.
  4. **O motor de regras precisa do ficheiro DTCC** (formato largo) e do mapeamento `BREAKING_FIELD` → `TP1_x` / `TP2_x`. A decisão "não usar a 3.2 diretamente" fica revogada para os valores.
  5. A observação "12/10 tem o dobro dos breaks" continua válida (é contagem, não depende destas colunas).

### 3.2 Relatório de reconciliação da DTCC (ficheiro recebido, formato LARGO)
Uma linha por transação, com pares de colunas `TP1_<campo>` / `TP2_<campo>` (TP1 = reporting counterparty = BNPP, TP2 = other counterparty = contraparte) para centenas de campos EMIR REFIT, mais as colunas de estado (`RCNCLTNRPT_ID`, `TXDTLS_ID`, `REC_CATEGORY`, `PAIRING_RECONCILIATION`, `VALUATION_RECONCILIATION`, LEIs, `FILENAME`, `C_PRIMARY_ASSET_CLASS`, `BUSINESS_DATE`).
- O nome dos sufixos nem sempre é simétrico (ex.: `TP1_..._LEG1` vs `TP2_..._LEG2`). ⚠️ **Corrigido em 2026-10-19 (ver 3.1.2):** é a **única fonte dos valores** de cada lado; a tabela longa só identifica o break. Texto original: **Não usar diretamente**: a tabela longa da 3.1 é a fonte da demo.
- **TP1 = `REPORTING_COUNTERPARTY_LEI` = BNPP; TP2 = `OTHER_COUNTERPARTY_LEGAL_LEI` = contraparte** (Ordep, 2026-10-20). Nos dados da BNPP, a party 1 é sempre o BNPP: lado BNPP = `TP1_<campo>`, lado contraparte = `TP2_<campo>`. Não é preciso lista de LEIs BNPP. Verificação barata opcional: `describe --overlap` dos dois LEIs no data mart deve dar `em_ambas` = 0.

**Regra do break (Ordep, 2026-10-20):** para cada campo, o break existe quando `TP1_<campo>` ≠ `TP2_<campo>` no ficheiro DTCC; o data mart só regista qual campo. **A chave de produção é única no ficheiro DTCC** (chaves distintas = linhas, 15/10) → join 1:1 break ↔ transação DTCC.

**Mapeamento validado com dados (`map-fields`, 15/10, top 20 campos):**
- Os 20 campos têm par `TP1_`/`TP2_` com o **mesmo nome** (inclui os 10 das regras).
- **100% dos breaks encontrados no DTCC pela chave e 100% com TP1 ≠ TP2; 0 breaks com TP1 = TP2.** A comparação exata reproduz todos os breaks.
- **18 dos 20 campos: 0 transações com TP1 ≠ TP2 sem break.** Comparação exata = regra do break; sem normalização (Ordep tinha razão).
- **Exceções: `VALUATION_AMT` (21.956 transações com TP1 ≠ TP2 sem break, 0,4%) e `VALUATION_CCY` (47.432, 0,8%).** Uma moeda não tem tolerância → hipótese principal: a valuation não é reconciliada nessas transações (ver `VALUATION_RECONCILIATION`), não tolerância de valor. A medir com `map-fields --explain`.
- Total do ficheiro DTCC de 15/10 pelas somas do `map-fields`: 6.277.763 transações (o `describe` foi colado como 6.271.763: provável gralha, confirmar).

**Medido em 2026-10-19 (`npm run describe`, ficheiro de 12/10, 5 ficheiros, um por asset class):**
  - **6.271.763 linhas** num dia (EQUITY 2,32M; FX 2,32M; COMMODITY 344k; CREDIT 126k; IR 109k). Contém todas as transações reportadas, não só as que têm break (o data mart de 12/10 tem ~300 mil positions).
  - **200 colunas:** 179 pares `TP1_`/`TP2_` e 22 colunas de contexto. **Todos os 179 pares são simétricos** (mesmo sufixo nos dois lados): o aviso acima sobre `LEG1`/`LEG2` não se confirma neste ficheiro.
  - Colunas de contexto: `RCNCLTNRPT_ID` (INTEGER), `TXDTLS_ID`, `RPT_ID` (INTEGER), `REFERENCE_DATE` (VARCHAR), `REC_CATEGORY`, `REPORTING_TYPE`, `PAIRING`, `RECONCILIATION`, `VALUATION_RECONCILIATION`, `REVIVED`, `FURTHER_MODIFICATION`, `TOTAL_NUMBER_TRANSACTIONS_RPT`, `ENTITY_RESP_FOR_REPORT`, `TOTAL_NUMBER_TRANSACTIONS`, `REPORT_SUBMITTING_ENTITY`, `REPORTING_COUNTERPARTY_LEI`, `OTHER_COUNTERPARTY_LEGAL_LEI`, `UTI`, `PROPRIETARY`, `FILENAME`, `C_PRIMARY_ASSET_CLASS`, `BUSINESS_DATE` (DATE).
  - Tem todas as colunas da chave de produção do data mart (3.1.2) → join candidato pela mesma chave, sem `BREAKING_FIELD`. Unicidade por medir.
  - Não tem as colunas de enriquecimento BNPP/TSR (essas só no data mart).


**TP1 = sempre `REPORTING_COUNTERPARTY_LEI`; TP2 = sempre `OTHER_COUNTERPARTY_LEGAL_LEI`** (Ordep, 2026-10-19). **TP1 não é necessariamente o BNPP:** o lado BNPP de cada linha tem de ser determinado (o BNPP pode estar em CP1 ou CP2, e tem várias entidades/LEIs). Sem isto, o motor de regras atribui o erro ao lado errado. Ver questão 27.

**Medido em 2026-10-19 (`npm run describe`, 15/10, 5 ficheiros, só estrutura):**
- 6.271.763 linhas num dia (COMMODITY 166.830; CREDIT 126.012; EQUITY 2.818.411; FOREIGN_EXCHANGE 2.815.513; INTEREST_RATE 850.997). O data mart tem ~293 mil positions com break nesse dia → o ficheiro DTCC traz **todas** as transações reconciliadas, não só as que estão em break (~5%).
- 380 colunas: **179 pares `TP1_`/`TP2_` todos simétricos** (o mesmo sufixo nos dois lados; a nota acima sobre `LEG1`/`LEG2` assimétricos não se confirma nos nomes) + 22 outras.
- As 22 outras incluem todas as colunas da chave de produção (`REPORT_SUBMITTING_ENTITY`, os dois LEIs, `UTI`, `PROPRIETARY`, `C_PRIMARY_ASSET_CLASS`, `BUSINESS_DATE` DATE) e `TXDTLS_ID` (VARCHAR), `RCNCLTNRPT_ID` (INTEGER), `RPT_ID` (INTEGER), `REFERENCE_DATE` (VARCHAR), `FILENAME`. **Não há `BREAKING_FIELD`**: o ficheiro tem os valores, o data mart diz qual campo está em break.
- Implicação de desenho: só interessam os pares `TP1_`/`TP2_` dos 10 campos + a chave. Materializar uma tabela estreita (chave + ~20 colunas), não as 380 × 6,3M.

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
- ⚠️ **Corrigido em 2026-10-19 (ver 3.1.2):** `bnpp_null` / `cpty_null` abaixo não significam "lado sem valor". **Saúde da chave (12/10, breaks distintos):** null_uti 23.247; null_cp1_lei 0; null_cp2_lei 0; same_lei 0; bnpp_null 311.682 (7,7%); **cpty_null 2.817.564 (69%)**.
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
| 2026-10-19 | ⚠️ **Substituída em 2026-10-20 (chave de produção).** **Chave do break usa `COALESCE(UTI, PROPRIETARY)`** (`columns.uti_alt` em `config/default.json`, resolvido em `logicalSelect` de `src/db/model.js`). Antes, os trades sem UTI do mesmo par de LEIs colapsavam num só break por campo. Aprovado pelo Ordep |
| 2026-10-19 | `npm run profile` esconde UTIs e LEIs por omissão (`--show-ids` para consulta local). Motivo: o output é colado em chats e documentos, e a regra "só agregados" falhava por mecânica |
| 2026-10-19 | Fixar a versão do `@duckdb/node-api` (`--save-exact`) em vez de `latest`. **Ainda não aplicado** (o `package.json` continua em `latest`): falta a versão instalada no PC do escritório. O `package-lock.json` **não** vai para o Git: os `resolved` apontariam para o Artifactory interno |

| 2026-10-19 | **Persistência = herança da categorização** (não KPI de aging). Motivo: um break que transita igual volta a aparecer sem categoria na app de produção, e o stock varia 0,2–3%/dia |
| 2026-10-19 | ⚠️ **Corrigido em 2026-10-19 (ver 3.1.2):** estas colunas não têm os valores; a definição de "igual" tem de ser refeita. "Mesmo break" para herança = mesma chave **e** `BNPP_REPORTED` e `CPTY_REPORTED` iguais (NULL = NULL). Se só mudar o lado CPTY, não herda (mais arriscado) |
| 2026-10-19 | Herança (fase 2) a partir da **última categorização** do mesmo break com os mesmos valores, até **N = 5 dias úteis**, com **continuidade** (se o break desaparece e volta, é novo). Ontem estrito perdia o que ainda não estava categorizado |
| 2026-10-19 | Persistência em 2 fases. **Fase 1 (feita):** métrica `persistence` com 4 grupos (igual / alterado / novo / resolvido), só com dados de breaks; o número é **potencial**, não poupança. **Fase 2:** herança real + backtest de concordância, bloqueada pela questão 2. Se a concordância ficar abaixo de ~95%, a herança passa a sugestão com confiança |
| 2026-10-19 | `excludedDates` em `config/default.json` (`["2026-10-12"]`; override `ODIN_EXCLUDED_DATES`). `breaks_dod` e `persistence` saltam-nas como dia anterior e recusam-nas como data pedida |
| 2026-10-19 | `persistence`: dimensões e filtros com o valor de D (de D-1 nos resolvidos), aplicados depois do join, para um break não se dividir se mudar de asset class. Primeira data sem dia anterior → contagens `null`, não "100% novo". Igualdade NULL-safe com `(a = b OR (a IS NULL AND b IS NULL))`, SQL standard |
| 2026-10-19 | Estado DTCC (`PAIRING` etc.) fora da persistência: o que se herda é a categorização do campo |
| 2026-10-19 | **Categorização adiada para outra fase** (decisão do Ordep: não é prioritária agora). Fica em espera: schema do histórico (q. 2), fase 2 da persistência (q. 18), métrica `reference_id_distribution`. Impacto no plano: ver decisão seguinte |
| 2026-10-19 | **Critérios de sucesso revistos** (aprovado pelo Ordep): o backtest sai e é substituído por "explicação pelas regras" (% de breaks dos 10 campos em que se identifica o lado que viola a regra ESMA, numa amostra validada pelos operacionais); mantém-se o fator de redução (persistência + clusters) e os casos reais. A sugestão de reference ID sai da demo. **O Excel de regras passa a ser o bloqueio do caminho crítico** |
| 2026-10-19 | Glob por omissão `data/breaks/**/*.parquet` (estrutura `{asset_class}/{AAAA-MM-DD}/` do S3) |
| 2026-10-19 | **Correção do Ordep:** `BNPP_REPORTED`/`CPTY_REPORTED` não são os valores do campo; os valores estão no ficheiro DTCC. Chave real de produção inclui `REPORT_SUBMITTING_ENTITY` e `C_PRIMARY_ASSET_CLASS` (ver 3.1.2). Persistência "igual/alterado", leitura de `cpty_null` e padrão de preenchimento ficam suspensos até redesenho |
| 2026-10-20 | **Chave do break = chave de produção** (Ordep): `REPORT_SUBMITTING_ENTITY, REPORTING_COUNTERPARTY_LEI, OTHER_COUNTERPARTY_LEGAL_LEI, UTI, PROPRIETARY, C_PRIMARY_ASSET_CLASS, BREAKING_FIELD` (+ business date). UTI e PROPRIETARY como colunas separadas (não COALESCE). `columns.uti_alt` → `columns.proprietary` (o nome antigo continua aceite). Também é a chave natural do join com o ficheiro DTCC, que tem as mesmas colunas. Contagens esperadas iguais (já não havia duplicados); obriga a `build:db` |
| 2026-10-20 | `profile`: saúde da chave deixa de mostrar `bnpp_null`/`cpty_null` (enganadores, ver 3.1.2); passa a mostrar `null_trade_id`, `both_uti_proprietary`, `proprietary_only`, `null_submitting_entity` |
| 2026-10-20 | **Lado BNPP = TP1** (`REPORTING_COUNTERPARTY_LEI`), contraparte = TP2 (`OTHER_COUNTERPARTY_LEGAL_LEI`). O motor de regras avalia `TP1_<campo>` como valor BNPP e `TP2_<campo>` como valor da contraparte |
| 2026-10-20 | Mapeamento `BREAKING_FIELD` → par `TP1_`/`TP2_` **validado com dados** (`npm run map-fields`): nome igual normalizado ou `--map` manual; nomes diferentes nunca são ligados automaticamente (só candidatos). Critério de mapeamento certo: `pct_break_diff` ≈ 100% e `pct_nobreak_diff` ≈ 0%. Se `pct_nobreak_diff` for alto, o Spark normaliza antes de comparar e o motor de regras tem de replicar essa normalização |
| 2026-10-20 | Sem normalização de valores no motor: TP1 e TP2 vêm do mesmo ficheiro DTCC (Ordep). Validação: `pct_nobreak_diff` do `map-fields` |
| 2026-10-20 | **Mapeamento BREAKING_FIELD → `TP1_`/`TP2_` = nome igual** para os top 20 (validado: 100% breaks com TP1 ≠ TP2). Sem tabela de mapeamento manual por agora; `--map` só para campos fora do top 20 que não batam |

---

## 6. Questões em aberto
1. **Mapeamento `BREAKING_FIELD` → campo do Excel de regras** (ex.: `VALUATION_AMT` → Table/Item ESMA). Os nomes são diferentes. Sem esta tabela de correspondência, as regras não se ligam aos breaks.
2. **Colunas do histórico de categorizações** e da tabela de reference IDs (código + descrição). Desbloqueia a métrica `reference_id_distribution` e o backtest.
3. Causa da duplicação e prazo da correção. Pista: `npm run profile` mostra `n_trade_numbers` por position; se for > 1, o fan-out vem do join com o enriquecimento TSR/BNPP. Com dados reais o `dup_factor` é 1,11 (ver 4.1): falta ver se está concentrado em trades de package.
4. **Por repetir:** a medição de 12/10 (top 20 de combinações = 99.653 de 304.012 positions, 32,8%) estava contaminada com dados sintéticos (ver 4.1). A leitura qualitativa provavelmente mantém-se, mas confirmar com o profile só com dados reais. Com ~15 campos por position, o conjunto exato é demasiado estrito: um campo a mais cria outra combinação. **Implicação:** a assinatura deve continuar ao nível do break (campo + padrão de preenchimento + regras), como no plano; o conjunto de campos por position serve de KPI ("20 padrões = 1/3 das positions"), não de unidade de cluster. Falta ver as 10 combinações (nomes de campos e contagens) e confirmar os grupos package/produto/valuation. Pergunta original: confirmar a hipótese dos grupos de campos correlacionados: `npm run profile -- --date <data>` com dados reais. **Bloqueado:** em 12/10 o profile parou depois da 1.ª secção (saúde da chave, positions duplicadas e combinações de campos não apareceram). Repetir sem redirecionar o output e ver o erro em stderr / `$LASTEXITCODE`.
5. Casos reais difíceis escolhidos pelos operacionais para a demo.
6. ~~Sistema operativo do PC do escritório.~~ **Fechado (2026-10-19):** Windows x64, Node v24.15.0.
7. Colunas físicas da chave: `REPORTING_COUNTERPARTY_LEI` e `OTHER_COUNTERPARTY_LEGAL_LEI` **existem** em todos os ficheiros com o mesmo tipo. Falta confirmar com os operacionais que é esta a chave que usam.
8. ~~Tipo de `BUSINESS_DATE`.~~ **Fechado (2026-10-19):** DATE; não é preciso `ODIN_BUSINESS_DATE_FORMAT`.
9. **Volume real:** 4,06M breaks distintos em 12/10. Confirmar com os operacionais se é o mesmo universo que veem na app (secção 1 fala de 1–2M/dia). É o primeiro número que vão contestar na demo.
10. ~~Chaves em conflito.~~ **Fechado (2026-10-19):** 0 conflitos em 12–15/10 com a chave corrigida. Os 123 medidos antes vinham dos dados sintéticos.
11. **Semântica de `BNPP_GLOBAL_BUSINESS_LINE`** face à "business line do código CRDS da contraparte" prevista. Confirmar com a equipa do data mart antes de mostrar como dimensão.
12. Alinhar os tipos das colunas `BNPP_*` entre os exports por asset class (pedido à equipa; não bloqueia a demo).
13. Carregar 13–15/10 para validar `breaks_dod` e a hipótese dos campos de package.
14. ~~Chave do break com `UTI` NULL.~~ **Resolvido (2026-10-19):** o identificador vem em `PROPRIETARY` quando falta o `UTI`; chave = `COALESCE(UTI, PROPRIETARY)`. **Falta medir o efeito:** rebuild + profile de 12/10. Esperado: `dup_factor` ≈ 1,0, `distinct_breaks` perto de 4,5M e muito menos `conflicting_keys`. Se assim for, a correção de duplicação pedida à equipa a 2026-10-16 pode ser cancelada.
    - **Medido com dados só reais (12–15/10, 20 ficheiros do S3, 5 asset classes por dia):**

      | business_date | raw_rows = distinct_breaks | distinct_positions | conflicting_keys | dup_factor |
      |---|---|---|---|---|
      | 2026-10-12 | 4.526.560 | 299.012 | 0 | 1,0 |
      | 2026-10-13 | 2.344.311 | 295.510 | 0 | 1,0 |
      | 2026-10-14 | 2.305.762 | 289.676 | 0 | 1,0 |
      | 2026-10-15 | 2.336.183 | 293.019 | 0 | 1,0 |

      **Zero duplicados e zero conflitos em todos os dias.** Toda a "duplicação" e todos os "conflitos" vinham da chave sem `PROPRIETARY`. O pedido à equipa de 2026-10-16 pode ser cancelado. A dedup fica como salvaguarda.
    - ⚠️ **Números anteriores contaminados:** uma medição intermédia de 12/10 (304.012 positions, 123 conflitos, ~4,54M breaks, combinações com cobertura de 32,8%) incluía por engano os dados sintéticos de 12/10 (+5.000 positions; os 123 conflitos eram os injetados pelo gerador). **Ignorar esses valores.** Causa exata desconhecida: provavelmente um glob que apanhou ficheiros sintéticos de 12/10 junto com os reais. Regra: confirmar sempre o `.env` e a lista de ficheiros (`Get-ChildItem data -Recurse -Filter *.parquet`) antes de medir.
    - **Dias normais (13–15/10, dados só reais):**
      - **Top 10 estável em 13 e 15/10** (a lista para as regras dos dias 3–5): VALUATION_AMT (~166–172k), VENUE_OF_EXECUTION, UNIQUE_PRODUCT_ID, ISIN, VALUATION_CCY, SETTLEMENT_CCY_1, PRODUCT_CLASSIFICATION, DELIVERY_TYPE, FLOAT_RATE_LEG2_IDENTIFIER, SPREAD_LEG2_TYP (~62k). Substitui a lista de 12/10 (atípico).
      - **Campos de package estáveis e fora do top 10:** PCKG_TRANS_SPREAD_TYP 27–28k/dia em 12–15/10. Não é pico; também não entra nos 10.
      - **`breaks_dod` 15 vs 14/10:** todos os 20 campos do topo variam entre +0,2% e +3,0%. Os breaks são um stock estável que transita de dia para dia, não um fluxo novo.
      - ⚠️ **Corrigido em 2026-10-19 (ver 3.1.2):** ler `bnpp_null` / `cpty_null` com cautela. **Saúde da chave (13/10):** null_uti 0; null LEIs 0; same_lei 0; **bnpp_null 447.015 (19%); cpty_null 138.644 (5,9%)**. O padrão "CPTY nulo = 69%" medido antes era de 12/10 com a chave antiga e não se aplica a dias normais.
      - **Sem duplicação por position:** nas positions com mais linhas, raw_rows = n_fields e 1 trade number (máximo ~37 campos por position).
      - **Combinações de campos (13/10):** as 20 primeiras cobrem 65.751 de 295.510 positions (22,3%). Cauda longa → a unidade de cluster é o break, não a position.
      - **Grupos correlacionados confirmados** (aparecem sempre juntos nas combinações): produto (UNIQUE_PRODUCT_ID + ISIN); valuation (VALUATION_AMT + VALUATION_CCY); package (os 3 PCKG_*); confirmação (CONFIRMATION_TIMESTAMP + CONFIRMED); e um trio DELIVERY_TYPE + FLOAT_RATE_LEG2_IDENTIFIER + SETTLEMENT_CCY_1. A combinação mais frequente (8.029 positions) junta 10 campos, incluindo EXCHANGE_RATE1, FWD_EXCHANGE_RATE e SETTLEMENT_CCY_1/2 (perfil de forwards FX). Implicação: regras por família de campos, não por campo isolado.
    - **12/10 tem o dobro dos outros dias** (4,5M vs ~2,3M), com o mesmo número de positions (~300 mil). Por isso o volume por position é o dobro. Perceber porquê (segunda-feira com acumulado do fim de semana? reprocessamento?) antes de usar 12/10 como referência na demo. Pista: com a chave antiga, 12/10 tinha cpty_null em 69% dos breaks, contra 5,9% em 13/10. Os ~2,2M breaks a mais podem ser quase todos de contraparte sem valor (ex.: um lado do relatório DTCC em falta nesse dia). **Confirmado (2026-10-19), com dados só reais:** 12/10 tem cpty_null = 3.168.040 de 4.526.560 (70%) e bnpp_null 344.010, contra 138.644 (5,9%) de cpty_null em 13/10. Os breaks com CPTY preenchido até são menos em 12/10 (~1,36M) do que em 13/10 (~2,2M). As positions de 12/10 chegam a ~61 campos em break (máx. ~37 em 13/10): campos inteiros sem valor do lado da contraparte.
      - **Conclusão:** 12/10 é um dia anómalo (lado da contraparte em falta para grande parte dos trades). **Excluir da demo e do backtest**; avisar quem gere o feed DTCC.
      - ⚠️ **Corrigido em 2026-10-19 (ver 3.1.2):** a causa de 12/10 não está explicada. **Oportunidade para a demo:** um alerta de qualidade "cpty_null passou de ~6% para 70%" teria detetado isto automaticamente.
      - Algumas positions de topo em 12/10 têm 0 `BNPP_TRADE_NUMBER` (enriquecimento interno em falta); a medir quando o trade number for usado.
    - **Top 10 com a chave corrigida (12/10, breaks distintos):** VALUATION_AMT 206.697; VENUE_OF_EXECUTION 175.033; VALUATION_CCY 158.384; UNIQUE_PRODUCT_ID 147.030; ISIN 132.397; CLEARING_OBLIGATION 120.406; PRODUCT_CLASSIFICATION 110.474; EXPIRATION_DATE 102.159; DELIVERY_TYPE 100.520; EFFECTIVE_DATE 95.763. Soma ≈ 1,35M (~30% dos breaks).
      - Mesma ordem que antes da correção; os campos de package continuam fora. Os grupos valuation (AMT/CCY) e produto (UPI/ISIN/CFI) estão todos no top 10.
      - **É esta a lista candidata para as regras dos dias 3–5**, não a da secção 4 (que tinha os 3 campos de package). Confirmar com 13–15/10: se os campos de package só sobem nalgum desses dias, é um pico pontual, não um campo estrutural.
    - Em aberto: o `PROPRIETARY` é o mesmo identificador que a contraparte reporta, ou um ID interno? Só afeta o rótulo na UI.
15. ~~Secção de combinações de campos do profile não aparecia.~~ **Resolvido (2026-10-19)** com a chave corrigida (os grupos gigantes sem UTI eram a causa provável).

16. **Persistência — medir com dados reais:** `npm run metric -- persistence --date 2026-10-14` e `--date 2026-10-15` (total e `--dims breaking_field`), e `npm run profile -- --date 2026-10-15` (secção "Mudança de identificador"). Primeira execução do SQL no DuckDB: só foi validado em SQLite (o registo npm não estava acessível no ambiente de desenvolvimento).
17. ~~**Mudança de identificador entre dias**~~ **Medido 14→15/10:** 3.505 positions novas, **0** com mudança de identificador. Não inflaciona a persistência; repetir se aparecerem dias com muitas positions novas. Texto original: **Mudança de identificador entre dias** (PROPRIETARY → UTI, ou UTI corrigido): infla "novo" e "resolvido". Se `id_changed_positions` for relevante face a `new_positions`, rever a chave da persistência (ex.: casar pelo trade number).
18. **Fase 2 da persistência:** precisa do schema do histórico (questão 2): grão (uma linha por break e por dia, ou por evento de categorização?), data da categorização e valores reportados nesse momento.
19. **Verificação do `_SUCCESS`** no `build:db` (secção 3.1.1): ainda não implementada. Hoje uma cópia incompleta do S3 entra sem aviso.
20. Versão exata do `@duckdb/node-api` instalada no PC do escritório (`npm ls @duckdb/node-api`), para fixar no `package.json`.
21. ~~**Impacto de adiar a categorização no plano aprovado.**~~ **Fechado (2026-10-19):** critérios revistos (ver registo de decisões). Texto original: sem histórico não há sugestão de reference ID com confiança, nem backtest (1.º critério de sucesso), nem herança real. Confirmar se a demo passa a ser "explicação do break pelas regras + fator de redução breaks → clusters + potencial de herança", e que critério substitui o backtest.
22. ⚠️ **Corrigido em 2026-10-19 (ver 3.1.2):** premissa errada; mantido como registo. **`cpty_null` — 13/10 é que destoa:** 14/10 = 527.447 de 2.307.763 (22,9%; `bnpp_null` 481.265, 20,9%); 15/10 = 535.736 de 2.335.182 (22,9%; `bnpp_null` 21%). Registado antes para 13/10: 138.644 (5,9%). Hipóteses: 13/10 tem a CPTY mais preenchida (dia atípico) ou o valor de 13/10 foi medido com outra versão dos dados. Repetir o profile de 13/10 e ver `persistence --date 2026-10-14` (se 13/10 for real, ~390 mil breaks "alterado" CPTY preenchido → nulo).
23. **Totais diferentes dos registados:** 15/10 = 2.335.182 (antes 2.336.183, −1.001); 14/10 = 2.307.763 (antes 2.305.762, +2.001). Diferenças "redondas" em dois dias: ou a cópia dos ficheiros mudou depois das primeiras medições, ou os valores foram mal transcritos. Confirmar com `Get-ChildItem` + `data_quality --from 2026-10-13 --to 2026-10-15` e corrigir a tabela da questão 14.
24. **O que contêm `BNPP_REPORTED` / `CPTY_REPORTED`?** (flag, valor parcial, outra coisa?) Decide se servem para alguma coisa na demo.
25. **Ficheiro DTCC:** mapeamento dos top 20 campos **validado** (ver 3.2). **Falta:** `map-fields --explain VALUATION_AMT` e `--explain VALUATION_CCY` (diferenças sem break por estado do relatório); caminho no S3 e `_SUCCESS`; `REFERENCE_DATE` vs `BUSINESS_DATE`; confirmar 6.277.763 vs 6.271.763 linhas.
26. ~~**Alinhar a chave do break com a de produção.**~~ **Feito (2026-10-20).** Falta confirmar com dados reais: `build:db` + `data_quality` 13–15/10 com os mesmos totais e 0 conflitos.
27. ~~**Lado BNPP em cada break.**~~ **Fechado (2026-10-20, Ordep):** BNPP = party 1 = `REPORTING_COUNTERPARTY_LEI` = `TP1_`; contraparte = party 2 = `TP2_`.

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
- **Feito (2026-10-19):** chave com `COALESCE(UTI, PROPRIETARY)`, validada com dados reais de 12–15/10 (20 ficheiros do S3): dup_factor 1,0 e 0 conflitos em todos os dias; gerador sintético passa a ter ~10% de positions só com `PROPRIETARY`; teste novo (16 testes).
- **Feito (2026-10-19, fim do dia):** 12–15/10 carregados (dados só reais); top 10 dos dias normais fechado; 12/10 confirmado como anómalo (70% cpty_null); `profile` esconde UTIs/LEIs por omissão (17 testes). **Dias 1–2 do plano fechados.**
- **Feito (2026-10-19, sessão da tarde):** métrica `persistence` (fase 1), desenhada em modo grill-me e aprovada.
  - `src/semantic/calendar.js` (dia anterior disponível com datas excluídas); `excludedDates` na config; `breaks_dod` passa a saltar 12/10.
  - `profile` com diagnóstico de mudança de identificador entre dias (só agregados).
  - Gerador sintético com breaks alterados, campos resolvidos e trades PROPRIETARY → UTI.
  - 24 testes (SQLite). Profile de 15/10 corre no DuckDB (diagnóstico de identificador: 0 mudanças). **Falta o output da métrica `persistence`.**
- **Correção (2026-10-19, fim da tarde):** os valores BNPP/CPTY não estão no data mart, estão no ficheiro DTCC (3.1.2). `persistence` só é fiável na parte de chave (novo / resolvido / continua); "igual" vs "alterado" suspenso. Questões 24–26.
- **Feito (2026-10-20):** chave do break = chave de produção (UTI e PROPRIETARY separados, + REPORT_SUBMITTING_ENTITY e asset class); 26 testes. **Precisa de `build:db` no PC do escritório.**
- **Feito (2026-10-20):** `npm run map-fields` (mapeamento BREAKING_FIELD → TP1_/TP2_ + matriz de confusão por campo, só contagens); `ODIN_DTCC_GLOB`; 30 testes.
- **Feito (2026-10-20):** mapeamento validado com dados reais (top 20 = nome igual, comparação exata reproduz 100% dos breaks); `map-fields --explain` para as exceções de valuation.
- **Plano mantido** (decisão 2026-10-19): backend Node primeiro (dias 3–8), React só nos dias 9–11.
- **Próximos passos:**
  1. **Desbloqueio (Ordep), caminho crítico:** partilhar o Excel de regras (`EMIR-Refit_Reconciliation status matching.xlsx`) para o mapeamento `BREAKING_FIELD` → regra dos 10 campos (questão 1). O schema do histórico (questão 2) fica em espera com a categorização.
  2. **Reunião com operacionais:** volume ~2,3M/dia é o universo deles? (q. 9); `PROPRIETARY` é o identificador que a contraparte vê?; porque recategorizam do zero se o stock é estável dia a dia?; 3–5 casos difíceis (q. 5).
  3. **Avisos:** cancelar o pedido de correção da duplicação (não existe); avisar o dono do feed DTCC sobre 12/10; fixar a versão do `@duckdb/node-api` (questão 20).
  4. **Correr a persistência com dados reais** (questões 16 e 17) e colar só os agregados.
  - **Em espera (categorização adiada):** schema do histórico, fase 2 da persistência, backtest.
  5. **Funcionalidades novas a desenhar (modo grill-me, plano aprovado antes de código):**
     - ~~**Persistência**~~ fase 1 feita; fase 2 depende da questão 2.
     - **Alerta de qualidade:** % cpty_null / bnpp_null por dia com limiar (teria detetado 12/10).
     - **Assinatura parcial do break:** campo + padrão de preenchimento + contraparte (primeiro "breaks → clusters" sem regras). Deve aplicar-se só aos breaks `novo` e `alterado`: os `igual` já têm caminho próprio (herança).
  6. Dias 3–5: regras ESMA por família de campos para os 10 campos de 13–15/10, assinaturas completas, backtest (excluindo 12/10).

## 8. Estrutura do repositório
```
config/default.json        mapeamento colunas físicas -> lógicas, caminhos (override: config/local.json, .env)
src/config.js              carrega config + .env
src/db/dialects.js         SQL específico de cada motor (duckdb, sqlite de testes)
src/db/model.js            modelo lógico, chave do break, breaks_raw/breaks (dedup)
src/db/duckdb.js           adaptador @duckdb/node-api (único ponto ligado ao driver)
src/semantic/catalog.js    métricas certificadas (6 do plano + persistence), dimensões e filtros permitidos
src/semantic/calendar.js   dia anterior disponível, datas excluídas
src/semantic/compiler.js   pedido estruturado -> SQL (whitelist + literais seguros)
src/semantic/runner.js     executa + auditoria
src/analysis/profile.js    queries exploratórias (combinações de campos, duplicação, chaves)
src/synthetic/generate.js  dados sintéticos (identificadores SYNTH*)
scripts/                   CLIs: synthetic, build-db, metric, profile, describe (estrutura de Parquet sem dados), map-fields
src/analysis/fieldmap.js   mapeamento BREAKING_FIELD -> TP1_/TP2_ e validação (matriz de confusão)
test/                      node:test
```
