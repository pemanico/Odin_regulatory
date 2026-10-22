# CLAUDE.md — Context of the "EMIR Breaks" project (agentic regulatory KPIs)

> **How to use this file**
> - Any assistant (the bank's Claude, Claude Code, or another one) must **read this file before any work**.
> - At the end of each working session, **update** the sections "Current status", "Decision log" and "Open questions".
> - **Never put real data in this file** (UTIs, values, counterparty names). Structure, decisions and aggregated metrics only.
> - **Language:** the whole project is in English (code, UI, identifiers, documentation) since 2026-10-21 — BNP Paribas is international. Conversations with Ordep may be in Portuguese.
> - Last update: 2026-10-22, end of session (demo running on the office PC; 15/10 being compared with production by a colleague; requirements guide in `docs/requirements.md`; next session: plan the next phase — agent, knowledge RAG with OpenSearch, server deployment)
> - **Requirements and onboarding of new jurisdictions:** [`docs/requirements.md`](docs/requirements.md).

---

## 1. What the project is

Web application where business users make requests by prompt and get KPIs, analysis reports or tables, on **regulatory data marts already processed by Spark**. The application is split by jurisdiction (EMIR, MiFID, CFTC, SEC, Canada, SFTR…) and will have an administration part (to be defined).

**First case: EMIR reconciliation/pairing breaks** between what BNPP reported and what the counterparty reported, from the reconciliation report received from DTCC.

### Business problem
Operations handle ~1–2M break rows per day, all categorised within 1–2 days, in bulk. The current manual flow is:
1. Search the breaks by business date in the web application.
2. Export to Excel.
3. Analyse `BREAKING_FIELD`, `BNPP_REPORTED` and `CPTY_REPORTED`.
4. Look up the rules Excel (ESMA + internal) to understand which side is wrong and why.
5. Categorise in the application with a reference ID (closed taxonomy); there is a history of this categorisation.
6. (Out of scope) Correct and resubmit.

**Where they lose the most time:** KPIs, top 10 breaking fields per business date, and identifying the error given the business rules.

---

## 2. APPROVED design plan (2026-10-16) — demo in 15 days

**Audience of the 1st presentation:** the operations users who analyse the errors. It is won with precision and evidence, not with visual effects.

### Scope
- **In:** EMIR only; KPIs by prompt over closed metrics; top 10 breaking fields per business date; error identification with the rules; reference ID suggestion with confidence.
- **Out:** approval with writes to the production app, administration, document RAG/OpenSearch, free SQL, other jurisdictions.

### Demo architecture
- **Engine:** local DuckDB reading Parquet copied to the machine. Future: ClickHouse on S3 / native tables. The SQL must use a standard subset (e.g. `COUNT(DISTINCT)`, not `uniq()`) so that the migration only changes the connection.
- **Deduplicated view:** grain = distinct break = **production key** `REPORT_SUBMITTING_ENTITY + LEI CP1 + LEI CP2 + UTI + PROPRIETARY + C_PRIMARY_ASSET_CLASS + BREAKING_FIELD` (per business date; UTI and PROPRIETARY as separate columns since 2026-10-20).
- **Semantic layer, 6 certified metrics** (grain = distinct break):
  1. Breaks per `BREAKING_FIELD` and business date
  2. Day-on-day change
  3. Top N fields
  4. Breaks per counterparty
  5. Reference ID distribution (history)
  6. Raw rows vs. distinct breaks (data quality KPI)
- **Rules engine:** the ESMA format and domain rules of the 10 highest-volume fields are compiled into SQL and evaluated **separately for the BNPP value and for the counterparty value**. Ambiguous internal rules are shown as text, without automatic checking.
- **Signature of a break** (basis for clustering and suggestion):
  - `BREAKING_FIELD`
  - population pattern (BNPP null / CPTY null / both populated) — ⚠️ **Corrected on 2026-10-19 (see 3.1.2):** it must come from the DTCC file
  - BNPP value valid under the rules? (yes/no + VR code)
  - CPTY value valid under the rules? (yes/no + VR code)
  - value pair (enums only)
  - counterparty

  Additional hypothesis: the useful cluster may be the **set of breaking fields per position** (see section 4).
- **Suggestion:** for each signature, the most frequent reference ID in the history, with the confidence %. Below a minimum threshold → "no suggestion". **Validation is always human (operations).** Agreement between the suggestion and the human decision is the engine's quality KPI.
- **Agent:** Claude through the bank's internal gateway, with tool calling. Tools: `list_metrics`, `query_metric(metric, dimensions, filters, date)`, `get_clusters(field, date)`. **The LLM never sees data rows**, only the schema, the metric definitions and the aggregated results. The break evidence is shown deterministically by the UI.
- **Backend:** Node.js + Express (npm install works at the office). DuckDB client (READ_ONLY, short-lived connection), gateway calls, audit log (prompt → metric → SQL). **Revised on 2026-10-20 (evening), see 2.1.**
- **Frontend:** React + Vite, 3 screens:
  1. Prompt with an answer as a table or chart
  2. Top 10 breaking fields per business date
  3. Drill-down field → ~~clusters~~ field combinations → transactions (Keys) → evidence (BNPP vs CPTY, rule violated) — see 2.1

  It has a jurisdiction selector, with only EMIR enabled.
- **Configuration:** table names, columns, paths and endpoints live in a configuration file/`.env`, never hardcoded.

### 2.1 APPROVED backend + frontend plan (2026-10-20, evening, grill-me)
- **Two classes of endpoints.** Agent tools, aggregates only: `GET /api/metrics` (`list_metrics`), `POST /api/query` (`query_metric`), plus the `open_drilldown` tool, which only returns filters to the UI. UI-only endpoints, with rows: `GET /api/keys` and `GET /api/keys/:id`. The LLM never calls these.
- **Demo on `localhost`** on the presenter's PC, without authentication (assumed; not explicitly confirmed).
- **Dense, dark UI** (compact tables, inline bars, keyboard shortcuts), with a strip of 4 KPIs at the top: breaks, Δ vs D-1, transactions, % unexplained. Audience: operations only.
- **Drill-down unit = Key/transaction** (production key without the field): field → field combinations (optional) → list of Keys with filters → expanding the Key shows **all** its breaks. Patterns by value pair are left for later.
- **Key verdict:** counts per verdict (to show) + `bnpp` / `counterparty` / `mixed` / `unexplained` (to filter and sort). The demo openly shows the % unexplained.
- **Screen 1:** suggested question chips + advanced query (builder). Free text is disabled until the agent exists. **The chips are the agent's test set** (`config/questions.json`).
- **Stack:** React + Vite + Express. Revokes "no build step / zip" (2026-10-16).
- **DuckDB READ_ONLY with a short-lived connection per request**, so the scripts can write while the server is up. Date selector only with dates that have `key_summary`.
- **Out:** agent, CSV export, authentication, patterns by value pair.

### Success criteria (revised on 2026-10-19: categorisation postponed)
- ~~**Backtest:** % of correct suggestions vs. the real categorisations of the last 2–4 weeks.~~ Postponed with the categorisation.
- **Explanation by the rules (replaces the backtest):** in X% of the breaks of the 10 fields, the tool states which side violates the ESMA rule. Measured on a sample validated by operations.
- **Reduction factor:** breaks → groups to decide (persistence "same" + clusters by signature; e.g. "2.3M → N decisions").
- **Real cases:** 3–5 hard cases, chosen by operations, solved live.

### Schedule (~11 working days)
| Days | Delivery |
|---|---|
| 1–2 | Dedup view, structure confirmed, DuckDB reading Parquet |
| 3–5 | Rules for the 10 fields, signatures, backtest |
| 6–8 | Backend, semantic layer, agent |
| 9–11 | UI (3 screens) |
| 12–13 | Tests with operations' cases |
| 14–15 | Buffer and rehearsal |

---

## 3. Data (structure — no real data)

### 3.1 Breaks table (data mart, LONG format — 1 row per break)
Oracle source: `T_AF_EMIR_RF_MATCHING` (read-only access via dblink). Parquet copy for the demo.

| Group | Columns |
|---|---|
| Break | `REC_STAT_ID`, `BREAKING_FIELD`, `BNPP_REPORTED`, `CPTY_REPORTED`, `RECONCILIATION_FLAG` |
| DTCC report IDs | `RCNCLTNRPT_ID`, `TXDTLS_ID`, `RPT_ID`, `REFERENCE_DATE`, `FILENAME`, `BUSINESS_DATE` |
| DTCC status | `REC_CATEGORY`, `REPORTING_TYPE`, `PAIRING`, `RECONCILIATION`, `VALUATION_RECONCILIATION`, `REVIVED`, `FURTHER_MODIFICATION`, `TOTAL_NUMBER_TRANSACTIONS`, `RPT` |
| Parties | `REPORTING_COUNTERPARTY_LEI`, `OTHER_COUNTERPARTY_LEGAL_LEI`, `REPORT_SUBMITTING_ENTITY`, `ENTITY_RESP_FOR_REPORT`, `PROPRIETARY` |
| Trade | `UTI`, `C_PRIMARY_ASSET_CLASS`, `MATCHIG_MSK` |
| Internal booking (TSR) | `TSR_BODY_ID`, `TSR_EXECUTION_TIMESTAMP`, `TSR_MATURITY_DATE_UNDERLYING`, `TSR_NOTIONAL_AMOUNT_LEG1/LEG2`, `TSR_NOTIONAL_CURRENCY_1/2`, `TSR_EXCHANGE_RATE_1`, `TSR_FORWARD_EXCHANGE_RATE`, `TSR_CONTRACT_TYPE` |
| BNPP enrichment | `BNPP_PORTFOLIO_ID`, `BNPP_BODY_ID`, `BNPP_REP_BEHALF_CODE_NAME`, `BNPP_EMIR_CLR_TSKLD_NAME`, `BNPP_EMIR_STATUS_NAME`, `BNPP_TRADE_NUMBER`, `BNPP_COUNTERPARTY_CRDS_CODE`, `BNPP_COUNTERPARTY_CRDS_CODE_BNPP_BUSINESS_LINE`, `BNPP_ACTIVITY_L1..L4` |

Notes:
- **Break key:** `UTI + LEI CP1 + LEI CP2 + BREAKING_FIELD` (+ `BUSINESS_DATE`). The two LEIs **may be equal** (legitimate case).
- **The trade identifier comes in `UTI` or in `PROPRIETARY`**, never in both (confirmed on 12/10: 489,446 rows with `PROPRIETARY` only, 0 with both, 0 with neither). Since 2026-10-20 they are **two separate logical columns** (`uti`, `proprietary`; empty text = NULL), both in the key, as in production and in the DTCC file. To show/aggregate a single identifier, `tradeIdExpr()` = `COALESCE(uti, proprietary)` is used.
- A break exists when the TP1 value ≠ TP2. **Both values come from the same DTCC file → there is no normalisation to do on our side** (Ordep, 2026-10-20; replaces the old note "signs and decimal places normalised in Spark"). To be confirmed with `pct_nobreak_diff` ≈ 0 in `map-fields`: if not, there are tolerances in the matching (DTCC or Spark) that the engine must know.
- A position can have several breaks (one per field).
- The enrichment columns (`BNPP_ACTIVITY_L1..L4`, business line, asset class, CRDS code) serve as dimensions for KPIs and clusters.

### 3.1.1 Location of the Parquet files in S3 (production)
- Path: `s3://uk-prd-s3-v2-prd-odin-airflow/trusted/emir_refit/matching_folder/{asset_class}/{YYYY-MM-DD}/`.
- Each folder has one or more `part-*.snappy.parquet` files and the pipeline's `_SUCCESS` control file.
- **Ingestion rules:**
  - Only read folders with `_SUCCESS`; a folder without it is an incomplete run.
  - Only read `*.parquet`, because the control files are not data.
  - Asset class and date come from the `C_PRIMARY_ASSET_CLASS` and `BUSINESS_DATE` columns, not from the folder name.
- **Pending decision:** copy to `data/breaks/` (working today) or read straight from S3 with DuckDB's `httpfs` extension. Depends on the extension installing through the proxy, AWS credentials on the PC and authorisation to read production from the desktop.

### 3.1.2 Correction (2026-10-19, Ordep): real key and where the values are
- **Key used in production** for the breaks:
  `RANK() OVER (PARTITION BY BREAKING_FIELD, REPORTING_COUNTERPARTY_LEI, OTHER_COUNTERPARTY_LEGAL_LEI, REPORT_SUBMITTING_ENTITY, UTI, PROPRIETARY, C_PRIMARY_ASSET_CLASS ORDER BY rownum)`.
  Our key had fewer columns (no `REPORT_SUBMITTING_ENTITY` or `C_PRIMARY_ASSET_CLASS`). As there are no more duplicates with the narrower key (question 14), the count does not change; the join between days (persistence) changes if one of these fields changes.
  Note: `RANK() ... ORDER BY rownum` behaves like `ROW_NUMBER()` (rownum is unique).
- **`BNPP_REPORTED` / `CPTY_REPORTED` are NOT the values of the field in break.** The data mart only says **which** field is in break. The values of each side are in the **DTCC file** (section 3.2, `TP1_<field>` / `TP2_<field>` columns). That is where the user validates the field against the rules document.
- **Consequences (to review, nothing implemented yet):**
  1. Everything that read `bnpp_null` / `cpty_null` as "that side has no value" has no basis: the 12/10 reading (70% cpty_null), "13/10 stands out" (question 22) and the proposed quality alert.
  2. The `persistence` metric compares `bnpp_value` / `cpty_value` → the "same" vs "changed" group does not measure what was approved. Only the key part (new / resolved / continues) is valid.
  3. The "population pattern" of the break signature cannot come from these columns.
  4. **The rules engine needs the DTCC file** (wide format) and the `BREAKING_FIELD` → `TP1_x` / `TP2_x` mapping. The decision "do not use 3.2 directly" is revoked for the values.
  5. The observation "12/10 has twice the breaks" remains valid (it is a count, it does not depend on these columns).

### 3.2 DTCC reconciliation report (received file, WIDE format)
One row per transaction, with `TP1_<field>` / `TP2_<field>` column pairs (TP1 = reporting counterparty = BNPP, TP2 = other counterparty = counterparty) for hundreds of EMIR REFIT fields, plus the status columns (`RCNCLTNRPT_ID`, `TXDTLS_ID`, `REC_CATEGORY`, `PAIRING_RECONCILIATION`, `VALUATION_RECONCILIATION`, LEIs, `FILENAME`, `C_PRIMARY_ASSET_CLASS`, `BUSINESS_DATE`).
- Suffix names are not always symmetric (e.g. `TP1_..._LEG1` vs `TP2_..._LEG2`). ⚠️ **Corrected on 2026-10-19 (see 3.1.2):** it is the **only source of the values** of each side; the long table only identifies the break. Original text: **Do not use directly**: the long table in 3.1 is the demo's source.
- **TP1 = `REPORTING_COUNTERPARTY_LEI` = BNPP; TP2 = `OTHER_COUNTERPARTY_LEGAL_LEI` = counterparty** (Ordep, 2026-10-20). In BNPP's data, party 1 is always BNPP: BNPP side = `TP1_<field>`, counterparty side = `TP2_<field>`. No list of BNPP LEIs is needed. Cheap optional check: `describe --overlap` of the two LEIs in the data mart must give `in_both` = 0.

**Break rule (Ordep, 2026-10-20):** for each field, the break exists when `TP1_<field>` ≠ `TP2_<field>` in the DTCC file; the data mart only records which field. **The production key is unique in the DTCC file** (distinct keys = rows, 15/10) → 1:1 join break ↔ DTCC transaction.

**Mapping validated with data (`map-fields`, 15/10, top 20 fields):**
- All 20 fields have a `TP1_`/`TP2_` pair with the **same name** (includes the 10 of the rules).
- **100% of the breaks found in the DTCC file by key and 100% with TP1 ≠ TP2; 0 breaks with TP1 = TP2.** The exact comparison reproduces every break.
- **18 of the 20 fields: 0 transactions with TP1 ≠ TP2 without a break.** Exact comparison = break rule; no normalisation (Ordep was right).
- **Exceptions: `VALUATION_AMT` (21,956 transactions with TP1 ≠ TP2 without a break, 0.4%) and `VALUATION_CCY` (47,432, 0.8%).** A currency has no tolerance → main hypothesis: the valuation is not reconciled in those transactions (see `VALUATION_RECONCILIATION`), not a value tolerance. To measure with `map-fields --explain`.
- Total of the 15/10 DTCC file from the `map-fields` sums: 6,277,763 transactions (`describe` was pasted as 6,271,763: probable typo, to confirm).

**Measured on 2026-10-19 (`npm run describe`, 12/10 file, 5 files, one per asset class):**
  - **6,271,763 rows** in one day (EQUITY 2.32M; FX 2.32M; COMMODITY 344k; CREDIT 126k; IR 109k). It contains every reported transaction, not only those with a break (the 12/10 data mart has ~300 thousand positions).
  - **200 columns:** 179 `TP1_`/`TP2_` pairs and 22 context columns. **All 179 pairs are symmetric** (same suffix on both sides): the warning above about `LEG1`/`LEG2` is not confirmed in this file.
  - Context columns: `RCNCLTNRPT_ID` (INTEGER), `TXDTLS_ID`, `RPT_ID` (INTEGER), `REFERENCE_DATE` (VARCHAR), `REC_CATEGORY`, `REPORTING_TYPE`, `PAIRING`, `RECONCILIATION`, `VALUATION_RECONCILIATION`, `REVIVED`, `FURTHER_MODIFICATION`, `TOTAL_NUMBER_TRANSACTIONS_RPT`, `ENTITY_RESP_FOR_REPORT`, `TOTAL_NUMBER_TRANSACTIONS`, `REPORT_SUBMITTING_ENTITY`, `REPORTING_COUNTERPARTY_LEI`, `OTHER_COUNTERPARTY_LEGAL_LEI`, `UTI`, `PROPRIETARY`, `FILENAME`, `C_PRIMARY_ASSET_CLASS`, `BUSINESS_DATE` (DATE).
  - It has every column of the data mart's production key (3.1.2) → candidate join on the same key, without `BREAKING_FIELD`. Uniqueness to be measured.
  - It does not have the BNPP/TSR enrichment columns (those are only in the data mart).


**TP1 = always `REPORTING_COUNTERPARTY_LEI`; TP2 = always `OTHER_COUNTERPARTY_LEGAL_LEI`** (Ordep, 2026-10-19). **TP1 is not necessarily BNPP:** the BNPP side of each row has to be determined (BNPP may be in CP1 or CP2, and has several entities/LEIs). Without this, the rules engine attributes the error to the wrong side. See question 27. *(Superseded on 2026-10-20: TP1 = BNPP, see above.)*

**Measured on 2026-10-19 (`npm run describe`, 15/10, 5 files, structure only):**
- 6,271,763 rows in one day (COMMODITY 166,830; CREDIT 126,012; EQUITY 2,818,411; FOREIGN_EXCHANGE 2,815,513; INTEREST_RATE 850,997). The data mart has ~293 thousand positions with a break on that day → the DTCC file carries **every** reconciled transaction, not only those in break (~5%).
- 380 columns: **179 `TP1_`/`TP2_` pairs, all symmetric** (the same suffix on both sides; the note above about asymmetric `LEG1`/`LEG2` is not confirmed in the names) + 22 others.
- The 22 others include every production key column (`REPORT_SUBMITTING_ENTITY`, both LEIs, `UTI`, `PROPRIETARY`, `C_PRIMARY_ASSET_CLASS`, `BUSINESS_DATE` DATE) and `TXDTLS_ID` (VARCHAR), `RCNCLTNRPT_ID` (INTEGER), `RPT_ID` (INTEGER), `REFERENCE_DATE` (VARCHAR), `FILENAME`. **There is no `BREAKING_FIELD`**: the file has the values, the data mart says which field is in break.
- Design implication: only the `TP1_`/`TP2_` pairs of the 10 fields + the key matter. Materialise a narrow table (key + ~20 columns), not the 380 × 6.3M.

### 3.3 Rules Excel used manually by operations
File: `EMIR-Refit_Reconciliation status matching.xlsx`. Columns: `Table`, `Item`, `Section`, `Field`, `Format`, `Conditions`, `Error codes`.
- The rules are the ESMA EMIR REFIT validation rules (`EMIR-VR-xxxx-nn` codes) plus internal rules.
- Complexity levels:
  1. format/domain
  2. conditions between fields
  3. external reference data (GLEIF, at the reporting date)
  4. state/lifecycle rules per UTI (sequence of action types). **These cannot be checked record by record.**
- **In the demo:** only levels 1 and 2 of the 10 highest-volume fields.


### 3.3.1 Mapping of the top 20 fields → ESMA rules (2026-10-20, **confirmed by Ordep**)
Sources: the `Validations_Cpty_derivative` sheet of the Excel (174 fields, ESMA validation rules only; **the internal rules are the same as ESMA's** — Ordep, 2026-10-20) + the "Field name → DTCC Mapping" file (134 rows). Chain: `BREAKING_FIELD` = TP suffix → "Field name" → Excel row.
Check types: **A** = only that side's value (format, enum, check digit); **B** = another TP field of the same side (conditional; available in the DTCC file); **C** = external list (MIC ISO 10383 with venue type, ISO 4217, ANNA DSB UPI); **L** = lifecycle (out of the demo).

| BREAKING_FIELD | Item | VR codes | Types |
|---|---|---|---|
| VALUATION_AMT | 2.21 | 2021-01 | A |
| UNIQUE_PRODUCT_ID | 2.8 | 2008-01..04 | B (2.7, 2.41), C (MIC, ANNA DSB) |
| VENUE_OF_EXECUTION | 2.41 | 2041-01..02 | C (MIC), A ('BILT') |
| ISIN | 2.7 | 2007-01..02 | B+C (venue type), A (check digit) |
| VALUATION_CCY | 2.22 | 2022-01..03 | B (2.21), C (ISO 4217), A (special codes) |
| SETTLEMENT_CCY_1 | 2.19 | 2019-01..05 | B (2.47), C (ISO 4217), A |
| DELIVERY_TYPE | 2.47 | 2047-01 | A |
| PRODUCT_CLASSIFICATION | 2.9 | 2009-01..02 | A (CFI structure), C (full ISO 10962) |
| FLOAT_RATE_LEG2_IDENTIFIER | 2.99 | 2099-01..02 | A (check digit), B (2.11, 2.14) |
| SPREAD_LEG2_TYP | 2.109 Spread of leg 2 (confirmed) | 2109-01..03 | no row in the mapping file |
| CLEARING_OBLIGATION | 2.30 | 2030-01..03 | B (2.31), B+C (venue type) |
| MASTER_AGREEMENT_VRSN_V | 2.36 Master Agreement version (confirmed) | 2036-01..02 | the mapping says `MASTER_AGREEMENT_VRSN`, the file has `_V` |
| SETTLEMENT_DATE | 2.46 Final contractual settlement date (confirmed) | 2046-01..04 | no row in the mapping file |
| EXPIRATION_DATE | 2.44 | 2044-01..05 | B (2.10, 2.42, 2.43), A (≥ 2014-02-12), L (-04 REVI) |
| CONFIRMATION_TIMESTAMP | 2.28 | 2028-01..05 | B (2.29, execution ts, reporting ts = `REFERENCE_DATE`, expiration) |
| SETTLEMENT_CCY_2 | 2.20 | 2020-01..03 | B (2.47), C (ISO 4217), A |
| EFFECTIVE_DATE | 2.43 | 2043-01..02 | A |
| EXCHANGE_RATE1 | 2.113 | 2113-01..03 | B (2.10, 2.11, 2.114), A |
| CONFIRMED | 2.29 | 2029-01 | B (2.31), B+C (venue type) |
| NOTIONAL_AMT_LEG2 | 2.64 | 2064-01 | A (accepts default 9999999999999999999999999) |

**Fundamental limit:** the VRs check whether **each side is valid**. In a break where both sides are valid but different (probably most of `VALUATION_AMT`, `NOTIONAL_AMT_LEG2`, dates), the rules **do not say who is wrong**. Possible result per break: only BNPP invalid / only CPTY invalid / both invalid / **both valid (divergence)**. The real coverage of the "explanation by the rules" criterion must be measured, not assumed.
**Opportunity:** the data mart has the internal booking (`TSR_EXECUTION_TIMESTAMP`, `TSR_NOTIONAL_AMOUNT_LEG1/2`, `TSR_NOTIONAL_CURRENCY_1/2`, `TSR_EXCHANGE_RATE_1`, `TSR_FORWARD_EXCHANGE_RATE`, `TSR_CONTRACT_TYPE`, `TSR_MATURITY_DATE_UNDERLYING`): for those fields, TP1 ≠ internal booking → the BNPP side is wrong, even when both sides are valid.

### 3.3.2 First run of the rules engine (15/10, rules v2026-10-20.1, 54 VR codes of the top 20)
Verdict names as renamed on 2026-10-21 (previously `sem_regras_verificaveis`, `divergencia`, `ambos`, `so_contraparte`, `so_bnpp`).

| Verdict | Breaks | % |
|---|---|---|
| no_verifiable_rules | 1,222,653 | 52.9% |
| divergence | 1,082,543 | 46.8% |
| both | 25,007 | 1.1% (almost all CONFIRMED, suspect rule) |
| cpty_only | 2,892 | 0.1% |
| bnpp_only | 2,087 | 0.1% |
- **`no_verifiable_rules`: ~965 thousand are fields outside the top 20** (step 3 of the plan not done yet) + VALUATION_AMT (166k) and NOTIONAL_AMT_LEG2 (28k) because they are DOUBLE columns in the Parquet (fixed afterwards: decimal on a numeric column now checks sign and magnitude) + SPREAD_LEG2_TYP (63k).
- **Suspect rule: EMIR-VR-2029-01 (CONFIRMED)** violates in ~93% of the breaks on both sides → the codes in the DTCC file are probably not YCNF/NCNF/ECNF. See the values with `describe --values TP1_CONFIRMED,TP2_CONFIRMED`.
- One-side violations found: UNIQUE_PRODUCT_ID (128 cpty), SETTLEMENT_DATE (92 bnpp / 110 cpty), EFFECTIVE_DATE (576 cpty), EXCHANGE_RATE1 (1 cpty), CONFIRMED (to review).
- **Reading (Claude):** the ESMA VRs are checked by the trade repository at submission; values that reached reconciliation already passed validation. That is why most breaks with rules come out `divergence`: the rules hardly ever say who is wrong. The explanation of the breaks has to come from elsewhere (value pair per field / TSR booking).

### 3.4 Categorisation history
It exists in Parquet and in Exadata, linked to the break key **with the reported values** (allows rebuilding the context of each decision). Closed taxonomy of reference IDs. **Columns not received yet.**

---

## 4. Findings (exploratory analysis of 2026-10-16)

- **Top 10 `BREAKING_FIELD`** (12–15/10/2026, ~4.5M raw rows): VALUATION_AMT, VENUE_OF_EXECUTION, PCKG_TRANS_SPREAD_TYP, PCKG_TRANS_SPREAD_CCY, PCKG_TRANS_SPREAD, UNIQUE_PRODUCT_ID, ISIN, VALUATION_CCY, PRODUCT_CLASSIFICATION, CLEARING_OBLIGATION.
- **Groups of correlated fields** (hypothesis to confirm):
  - package (SPREAD_TYP / SPREAD_CCY / SPREAD, almost equal counts);
  - product (UPI / ISIN / CFI);
  - valuation (AMT / CCY).
- ~~**Severe duplication:**~~ **Disproved on 2026-10-19 (see 4.1):** it was the wrong key (UTI vs PROPRIETARY), not duplication. Original text: some positions have ~127 rows per field on the same day (e.g. 2,667 rows for 21 distinct fields). Raw counts are inflated. **Fix requested from the team (2026-10-16).** Probable cause to investigate: fan-out in the join with the enrichment (TSR/BNPP) or several `RPT_ID`/`TXDTLS_ID` per UTI. The demo always uses the deduplicated view.
- The source Oracle is older than 12.2: it does not support `LISTAGG ... ON OVERFLOW`.

### 4.1 First build with real data (business date 2026-10-12, 2026-10-19)
- **Files:** one Parquet per asset class and per business date (`matching_<co|cr|eq|fx|ir>_<yyyymmdd>.snappy.parquet`). Read together with `union_by_name`.
- **Schema:** `BUSINESS_DATE` is DATE. `REC_STAT_ID` is INTEGER (correct numeric order in the dedup). `breaking_field` comes in **lower case** (irrelevant in DuckDB; careful in ClickHouse, which is case-sensitive).
- **Type differences between asset classes** (unmapped columns, no impact today): `BNPP_BODY_ID` DECIMAL(38,10) vs INTEGER (`eq`); `BNPP_PORTFOLIO_ID` DECIMAL (`fx`,`ir`) vs VARCHAR; `BNPP_PLATFORM_ID` missing in `co` and `eq`. The exports do not come out with an aligned schema.
- **Unexpected columns:** `BNPP_GLOBAL_BUSINESS_LINE`, `BNPP_SUB_BUSINESS_LINE`, `BNPP_METIER`, `BNPP_PLATFORM_ID`, `TOTAL_NUMBER_TRANSACTIONS_RPT`. `BNPP_COUNTERPARTY_CRDS_CODE_BNPP_BUSINESS_LINE` does not exist.
- **`data_quality` (12/10):** raw_rows 4,526,560; distinct_breaks 4,060,361; distinct_positions 276,153; conflicting_keys 5,132 (0.13%); dup_factor 1.11.
- **Reading:**
  - Duplication is **not severe in aggregate** (~466 thousand extra rows, ~10%). The ~127 rows/field of section 4 are probably cases concentrated in a few positions; to confirm with the "positions with the most raw rows" section of the profile.
  - **Real volume larger than described:** 4.06M distinct breaks in a single day (~14.7 fields per position). Contradicts "~4.5M rows over 12–15/10" (section 4) and "1–2M rows/day" (section 1).
  - **Deduplicated top 20 (12/10):** VALUATION_AMT, VENUE_OF_EXECUTION, VALUATION_CCY, UNIQUE_PRODUCT_ID, ISIN, CLEARING_OBLIGATION, PRODUCT_CLASSIFICATION, EXPIRATION_DATE, DELIVERY_TYPE, EFFECTIVE_DATE, NOTIONAL_AMT_LEG2, SETTLEMENT_DATE, NOTIONAL_AMT_LEG1, EXECUTION_TIMESTAMP, MASTER_AGREEMENT_TYPE, SPREAD_LEG2_TYP, NOTIONAL_AMT_LEG2_CCY, CONTRACT_TYPE, NOTIONAL_AMT_LEG1_CCY, FLOAT_RATE_LEG2_IDENTIFIER.
  - **The 3 package fields (`PCKG_TRANS_SPREAD*`) are not in the deduplicated top 20** (the 20th has 66,427), but they were 3rd–5th in the raw top 10 of section 4. Hypothesis: the raw ranking was inflated by duplication and the fan-out is concentrated in package trades. Confirm with 13–15/10 loaded.
- ⚠️ **Corrected on 2026-10-19 (see 3.1.2):** `bnpp_null` / `cpty_null` below do not mean "side without a value". **Key health (12/10, distinct breaks):** null_uti 23,247; null_cp1_lei 0; null_cp2_lei 0; same_lei 0; bnpp_null 311,682 (7.7%); **cpty_null 2,817,564 (69%)**.
  - Most breaks are the counterparty without a value in the field. It is probably the demo's largest cluster ("CPTY null" pattern) and the largest breaks → decisions reduction factor.
  - `same_lei` = 0 on this day, although it is a legitimate case.
- **Positions with the most raw rows — all have a NULL `UTI`.** The first 10 add up to 317,063 raw rows (≈68% of the 466 thousand excess), with 56–92 fields and **66 to 3,395 distinct `BNPP_TRADE_NUMBER`** each.
  - They are not duplicates of one position: they are **thousands of different trades without a UTI grouped under the same LEI pair**.
  - **The "severe duplication" of section 4 is largely this artefact**, not enrichment fan-out.
  - **Impact on the dedup:** `ROW_NUMBER() OVER (PARTITION BY uti, cp1_lei, cp2_lei, breaking_field ...)` puts every NULL UTI of the same LEI pair in the same partition. Breaks of different trades without a UTI collapse into one per field. `distinct_breaks` is **undercounted** (up to ~300 thousand breaks on 12/10) and part of the `conflicting_keys` are these cases, not real conflicts. See question 14.

---

## 5. Decision log
| Date | Decision |
|---|---|
| 2026-10-16 | OpenSearch, in the future, serves as semantic catalog + document RAG; out of the demo |
| 2026-10-16 | Hybrid approach: semantic layer for recurring KPIs; free SQL only in the future, as a flagged fallback |
| 2026-10-16 | Spark already computes the breaks; there is no validation rules engine to build, only checking the rules per side to explain the break |
| 2026-10-16 | Classify by patterns/clusters, never LLM per break (volume) |
| 2026-10-16 | Validation always human (operations); the system suggests with confidence |
| 2026-10-16 | LLM: Claude via the internal gateway; the LLM does not see data rows |
| 2026-10-16 | Local DuckDB for the demo; npm install works at the office |
| 2026-10-16 | Demo design plan approved |
| 2026-10-16 | Code in JavaScript ESM (Node ≥ 20), no build step, to run straight from a zip. ⚠️ **Revoked on 2026-10-20** for the frontend (React + Vite) |
| 2026-10-16 | Everything specific to the SQL engine lives in `src/db/dialects.js`; the metrics use standard SQL only |
| 2026-10-16 | Filter values rendered as validated and escaped literals (`src/semantic/literals.js`); identifiers only from the catalog. Works the same in DuckDB, ClickHouse and SQLite, without depending on the driver's parameter API |
| 2026-10-16 | Dedup: in each break key the row with the lowest `REC_STAT_ID` is kept; duplicates with different values are not hidden, they are counted in `data_quality.conflicting_keys` |
| 2026-10-16 | "Previous day" in `breaks_dod` = previous business date **available in the data**, not the previous calendar day |
| 2026-10-16 | Demo UI: medium, functional look (dense tables, clear filters); visual polish later. Colours in a theme file (tokens) with a provisional green, to be replaced by the official hex codes; logo as a local file outside Git |
| 2026-10-16 | `build:db` materialises `breaks_raw` and `breaks` as tables in a local DuckDB database (fast repeated queries) |
| 2026-10-19 | `config/local.json` with `business_line` → `BNPP_GLOBAL_BUSINESS_LINE` (the most aggregated level of the Global > Sub > Métier hierarchy). Provisional until the semantics are confirmed with the data mart team. No code change |
| 2026-10-19 | ⚠️ **Superseded on 2026-10-20 (production key).** **Break key uses `COALESCE(UTI, PROPRIETARY)`** (`columns.uti_alt` in `config/default.json`, resolved in `logicalSelect` in `src/db/model.js`). Before, trades without a UTI of the same LEI pair collapsed into one break per field. Approved by Ordep |
| 2026-10-19 | `npm run profile` hides UTIs and LEIs by default (`--show-ids` for local use). Reason: the output is pasted into chats and documents, and the "aggregates only" rule was failing mechanically |
| 2026-10-19 | Pin the `@duckdb/node-api` version (`--save-exact`) instead of `latest`. **Not applied yet** (`package.json` still says `latest`): the version installed on the office PC is missing. `package-lock.json` does **not** go into Git: the `resolved` entries would point to the internal Artifactory |
| 2026-10-19 | **Persistence = inheriting the categorisation** (not an aging KPI). Reason: a break that carries over unchanged reappears without a category in the production app, and the stock varies 0.2–3%/day |
| 2026-10-19 | ⚠️ **Corrected on 2026-10-19 (see 3.1.2):** these columns do not hold the values; the definition of "same" has to be redone. "Same break" for inheritance = same key **and** equal `BNPP_REPORTED` and `CPTY_REPORTED` (NULL = NULL). If only the CPTY side changes, it does not inherit (riskier) |
| 2026-10-19 | Inheritance (phase 2) from the **latest categorisation** of the same break with the same values, up to **N = 5 working days**, with **continuity** (if the break disappears and comes back, it is new). Strict "yesterday" missed what was not categorised yet |
| 2026-10-19 | Persistence in 2 phases. **Phase 1 (done):** `persistence` metric with 4 groups (same / changed / new / resolved), breaks data only; the number is a **potential**, not a saving. **Phase 2:** real inheritance + agreement backtest, blocked by question 2. If agreement is below ~95%, inheritance becomes a suggestion with confidence |
| 2026-10-19 | `excludedDates` in `config/default.json` (`["2026-10-12"]`; override `ODIN_EXCLUDED_DATES`). `breaks_dod` and `persistence` skip them as previous day and reject them as requested date |
| 2026-10-19 | `persistence`: dimensions and filters with the value of D (of D-1 for resolved), applied after the join, so that a break is not split if it changes asset class. First date without a previous day → `null` counts, not "100% new". NULL-safe equality with `(a = b OR (a IS NULL AND b IS NULL))`, standard SQL |
| 2026-10-19 | DTCC status (`PAIRING` etc.) out of persistence: what is inherited is the field categorisation |
| 2026-10-19 | **Categorisation postponed to another phase** (Ordep's decision: not a priority now). On hold: history schema (q. 2), phase 2 of persistence (q. 18), `reference_id_distribution` metric. Impact on the plan: see next decision |
| 2026-10-19 | **Success criteria revised** (approved by Ordep): the backtest goes and is replaced by "explanation by the rules" (% of breaks of the 10 fields in which the side violating the ESMA rule is identified, on a sample validated by operations); the reduction factor (persistence + clusters) and the real cases stay. The reference ID suggestion leaves the demo. **The rules Excel becomes the blocker on the critical path** |
| 2026-10-19 | Default glob `data/breaks/**/*.parquet` (S3 structure `{asset_class}/{YYYY-MM-DD}/`) |
| 2026-10-19 | **Ordep's correction:** `BNPP_REPORTED`/`CPTY_REPORTED` are not the field values; the values are in the DTCC file. The real production key includes `REPORT_SUBMITTING_ENTITY` and `C_PRIMARY_ASSET_CLASS` (see 3.1.2). Persistence "same/changed", the `cpty_null` reading and the population pattern are suspended until redesigned |
| 2026-10-20 | **Break key = production key** (Ordep): `REPORT_SUBMITTING_ENTITY, REPORTING_COUNTERPARTY_LEI, OTHER_COUNTERPARTY_LEGAL_LEI, UTI, PROPRIETARY, C_PRIMARY_ASSET_CLASS, BREAKING_FIELD` (+ business date). UTI and PROPRIETARY as separate columns (not COALESCE). `columns.uti_alt` → `columns.proprietary` (the old name is still accepted). It is also the natural join key with the DTCC file, which has the same columns. Counts expected to be equal (there were no duplicates any more); requires `build:db` |
| 2026-10-20 | `profile`: key health no longer shows `bnpp_null`/`cpty_null` (misleading, see 3.1.2); it shows `null_trade_id`, `both_uti_proprietary`, `proprietary_only`, `null_submitting_entity` |
| 2026-10-20 | **BNPP side = TP1** (`REPORTING_COUNTERPARTY_LEI`), counterparty = TP2 (`OTHER_COUNTERPARTY_LEGAL_LEI`). The rules engine evaluates `TP1_<field>` as the BNPP value and `TP2_<field>` as the counterparty value |
| 2026-10-20 | `BREAKING_FIELD` → `TP1_`/`TP2_` pair mapping **validated with data** (`npm run map-fields`): same normalised name or manual `--map`; different names are never linked automatically (candidates only). Criterion for a right mapping: `pct_break_diff` ≈ 100% and `pct_nobreak_diff` ≈ 0%. If `pct_nobreak_diff` is high, Spark normalises before comparing and the rules engine must replicate that normalisation |
| 2026-10-20 | No value normalisation in the engine: TP1 and TP2 come from the same DTCC file (Ordep). Validation: `pct_nobreak_diff` in `map-fields` |
| 2026-10-20 | **BREAKING_FIELD → `TP1_`/`TP2_` mapping = same name** for the top 20 (validated: 100% of breaks with TP1 ≠ TP2). No manual mapping table for now; `--map` only for fields outside the top 20 that do not match |
| 2026-10-20 | Mapping of the top 20 fields → ESMA items confirmed (3.3.1). Internal rules = ESMA rules (single source: the Excel) |
| 2026-10-20 | **Rules engine — result per break:** only BNPP violates / only counterparty violates / both violate (with VR codes) / **both valid → fixed message "divergence: both values comply with the ESMA rules; the rules do not determine the wrong side"** with both values side by side (option a). Tie-break with the TSR internal booking (option b) is for the future |
| 2026-10-20 | **The engine only uses the TP1_/TP2_ fields of the DTCC file** (Ordep): no external lists (MIC, ISO 4217, ANNA DSB). Sub-rules that need a list → "not verifiable" with the rule text. Conditional rules evaluate each side with **its own** other fields (BNPP with TP1_*, counterparty with TP2_*) |
| 2026-10-20 | **Engine scope: rules for every field** in the Excel (174 items), not only the top 10/20 (Ordep). The UI shows what the user asks for. Implies a declarative representation of the rules (not hand-written SQL per rule) |
| 2026-10-20 | Rules translated by Claude into a declarative file; validation = violation rate on the real data + sample review by Ordep (top 20 and suspect rules) |
| 2026-10-20 | Rule results **precomputed** per business date (`npm run rules -- --date`) in a `rule_results` table; DTCC file read as a view on the Parquet (not copied) |
| 2026-10-20 | **Rules engine plan approved** (Ordep). "field X.Y" references = Excel `Table.Item` → Field name → TP suffix; common fields (UTI, LEIs, `REFERENCE_DATE`) apply to both sides |
| 2026-10-20 | **Who runs the rules: deterministic SQL (`npm run rules`), not an agent/LLM.** Same reasons as the 2026-10-16 decision (volume, audit, the LLM does not see rows). The agent only reads aggregated `break_verdict`/`rule_results` to answer prompts. In production: run by the daily pipeline (Airflow) after the DTCC file arrives |
| 2026-10-20 | 5th verdict `no_verifiable_rules` (field without verifiable rules or not in the rules file), separate from `divergence`, so that coverage is not hidden |
| 2026-10-20 | Format rules on typed columns in the Parquet (DECIMAL, DATE, TIMESTAMP) → not verifiable (the original reported format is lost); enum/compare stay |
| 2026-10-20 | **Engine scope: data mart breaks only** (Ordep). Each rule only runs on the breaks of its own field (the VALUATION_CCY rule only on VALUATION_CCY breaks). Validating every transaction of the DTCC file = **"data quality", future requirement** |
| 2026-10-20 | Translation filter (replaces point 5 of the plan, which measured on every transaction): a rule is **suspect if it violates on both sides in > 5% of the breaks of its field** — a real error is usually on one side; a wrong translation fails on both |
| 2026-10-20 | **Always show the break key** (Ordep) so that operations can find it: `npm run rules` writes `data/reports/break-verdict-<date>.csv` with the production key + verdict + VR codes. **Local only** (data/ is in .gitignore); screen and chat stay aggregates only |
| 2026-10-20 | `decimal` on a numeric Parquet column (DOUBLE, DECIMAL...): checks sign and magnitude (integer part ≤ digits), not the format |
| 2026-10-20 | **Step 3 done: all 409 VR codes in the Excel translated** (rules v2026-10-20.2): 150 verifiable, 73 partial, 186 not verifiable. 126 of the 128 fields with TP columns have at least one verifiable rule (exceptions: 2.51, without codes in the Excel; 2.109 spread of leg 2). Not verifiable: fields without DTCC columns (40) or common ones, GLEIF, MIC list, lifecycle, repeatable schedules, monetary/percentage notation. The DSL gained `if`, `equals_any`, `not_equal` |
| 2026-10-20 | Excel typos interpreted: 'ENRVR' → ENVR, 'FRLTL' → FRTL (2.116/2.117); code 'EMIR -VR-2042-03' → EMIR-VR-2042-03; 2.51 without error codes |
| 2026-10-20 | Manual validation: `npm run rules:sample` (10 breaks spread across the verdicts; local CSV with key and values; Ordep reports back only number + correct Y/N + reason) |
| 2026-10-20 | **Classification validated by Ordep on the 15/10 sample** ("the classification is right") |
| 2026-10-20 | **Presentation per break** (Ordep): field = name in the rules document ("2.22 Valuation currency"); BNPP value = `TP1_<field>`; other cpty value = `TP2_<field>`; **no VR code for now**; the error is the format/condition rule violated, as text (generated from the translation, in English like the ESMA document). `break_detail` table + local CSV; `rules:sample` reads from it |
| 2026-10-20 | **Only fields with `TP1_<field>` and `TP2_<field>` in the DTCC file are validated** (Ordep). Catalog v2026-10-20.3: **274 VR codes of the 128 fields with TP** (150 verifiable, 73 partial, 51 not verifiable); the 135 codes of the 46 fields without TP or with common columns leave the catalog. `validateRules` rejects rules of fields without TP |
| 2026-10-20 | Rules comparing with common columns (REFERENCE_DATE, LEIs, UTI) = not verifiable (Ordep). Catalog v2026-10-20.4: 274 codes — 147 verifiable, 69 partial, 58 not verifiable |
| 2026-10-20 | **Rules engine closed** (Ordep); testing with production data is on Ordep's side. Step 4 of the plan: certified metric `rule_verdict` (on `break_verdict`; dimensions verdict, field, date, asset class, counterparty) |
| 2026-10-20 | **Order revised: backend + frontend before the agent** (Ordep) |
| 2026-10-20 | **The demo is not presented before the agent** (Ordep). Screen 1 with metric selector + filters is only intermediate; the backend API must expose the same operations as the agent tools (`list_metrics`, `query_metric`, drill-down), so that the agent fits in without redoing the backend |
| 2026-10-20 | **Backend + frontend plan approved** (Ordep, grill-me; see 2.1) |
| 2026-10-20 | Endpoints in two classes: agent tools with aggregates only; `/api/keys` with rows for the UI only, never a tool (Ordep) |
| 2026-10-20 | UI: terminal density (dark theme, compact tables, shortcuts) + KPI strip; audience = operations (Ordep) |
| 2026-10-20 | Drill-down by **Key/transaction**: field combinations (optional) + list of Keys with filters; expanding shows every break of the Key (Ordep, options c + a). Replaces grouping by pattern/value pair, which is left for later |
| 2026-10-20 | Key verdict: counts per verdict + `bnpp`/`counterparty`/`mixed`/`unexplained` (Ordep, b + c). A `both` field counts as `mixed` (Claude) |
| 2026-10-20 | Screen 1: suggested question chips + advanced query (Ordep, option c). Initial questions written by Claude; operations correct them |
| 2026-10-20 | **React + Vite + Express** (Ordep). Revokes "no build step, run from a zip" (2026-10-16) |
| 2026-10-20 | DuckDB READ_ONLY with a short-lived connection per request (Ordep, option a); lock error → 503 "the database is being updated" |
| 2026-10-20 | `key_summary` precomputed by `npm run rules` (Claude; no objection): synthetic `key_id` per date, so that the key never goes into the URL |
| 2026-10-20 | New certified metrics: `key_verdict` and `field_combinations`. Filters on `breaking_field` become case-insensitive (lower case in the data mart, upper case in `break_verdict`) |
| 2026-10-20 | API logic in a framework-free module (`src/server/api.js`), tested with SQLite; Express is only the wrapper (`app.js`) |
| 2026-10-20 | Verdict colours validated (CVD) on the dark background: violet = both/mixed, orange = BNPP, blue = counterparty; divergence and no rules in neutrals (no rules with a texture) |
| 2026-10-21 | **The whole application is in English** (Ordep: "BNP Paribas is international"): UI, identifiers, database columns, API and CLI messages, metric catalog, agent tool descriptions, rules config notes, code comments, README and CLAUDE.md. Suggested questions in English → operations are expected to ask the agent in English |
| 2026-10-21 | English identifiers: verdicts `bnpp_only`, `cpty_only`, `both`, `divergence`, `no_verifiable_rules`; Key verdicts `bnpp`, `counterparty`, `mixed`, `unexplained`; persistence `same`, `changed`, `new`, `resolved`; rule status `verifiable`, `partial`, `not_verifiable` (field `note`). `break_detail` columns `field_label`, `bnpp_value`, `other_cpty_value`, `verdict_text`, `bnpp_error`, `other_cpty_error`; `key_summary` columns `n_bnpp_only`, `n_cpty_only`, `n_both`, `n_divergence`, `n_no_rules`. Screen 1 renamed "Query" (`#/query`). Rules catalog version 2026-10-21.1 (same rules, translated notes) |
| 2026-10-21 | `npm run rules` detects the legacy (Portuguese) rule tables and drops them (`rule_results`, `break_verdict`, `break_detail`, `key_summary`); every business date must be run again (Claude) |
| 2026-10-21 | `npm run rules` diagnoses an empty input (no DTCC transactions with a break on the date): lists the database used and the dates/counts on each side, and says which one is missing (Claude) |
| 2026-10-21 | Number formatting in the UI: en-GB (comma thousands, point decimals); dates stay dd/mm/yyyy (Claude) |
| 2026-10-22 | React effects never return a value (`useEffect(() => { ... })`): recent Chrome/Edge return a Promise from `scrollIntoView`, which crashed the Query screen. Error boundary per screen and per answer card (Claude) |
| 2026-10-22 | **Other dates (13–14/10) paused** (Ordep): a colleague is comparing the 15/10 results with production first |
| 2026-10-22 | **Move to the next phase** (Ordep): knowledge RAG (upload of internal documents through the web app, indexed in OpenSearch) and running the application on servers (Node.js). Order of the phase (agent / RAG / server) not decided yet — open question 48; Claude recommends agent first |
| 2026-10-22 | **Requirements guide written from the code and the decisions, not by reverse engineering into per-file markdown** (Claude, accepted by Ordep): `docs/requirements.md` — principles, data contract, rules engine, metrics, API/UI, non-functional requirements, refactors R1–R10 needed before the second jurisdiction, onboarding checklist |

---

## 6. Open questions
1. **Mapping `BREAKING_FIELD` → rules Excel field** (e.g. `VALUATION_AMT` → ESMA Table/Item). The names are different. Without this correspondence table, the rules do not link to the breaks. *(Answered by 3.3.1 for the top 20.)*
2. **Columns of the categorisation history** and of the reference ID table (code + description). Unblocks the `reference_id_distribution` metric and the backtest.
3. Cause of the duplication and deadline for the fix. Hint: `npm run profile` shows `n_trade_numbers` per position; if > 1, the fan-out comes from the join with the TSR/BNPP enrichment. With real data `dup_factor` is 1.11 (see 4.1): still to see whether it is concentrated in package trades. *(See q. 14: there is no duplication.)*
4. **To repeat:** the 12/10 measurement (top 20 combinations = 99,653 of 304,012 positions, 32.8%) was contaminated with synthetic data (see 4.1). The qualitative reading probably holds, but confirm with the profile on real data only. With ~15 fields per position, the exact set is too strict: one more field creates another combination. **Implication:** the signature should stay at break level (field + population pattern + rules), as in the plan; the set of fields per position serves as a KPI ("20 patterns = 1/3 of positions"), not as the cluster unit. Still to see the 10 combinations (field names and counts) and confirm the package/product/valuation groups. Original question: confirm the hypothesis of correlated field groups: `npm run profile -- --date <date>` with real data. **Blocked:** on 12/10 the profile stopped after the 1st section (key health, duplicated positions and field combinations did not appear). Repeat without redirecting the output and check the error in stderr / `$LASTEXITCODE`.
5. Hard real cases chosen by operations for the demo.
6. ~~Office PC operating system.~~ **Closed (2026-10-19):** Windows x64, Node v24.15.0.
7. Physical key columns: `REPORTING_COUNTERPARTY_LEI` and `OTHER_COUNTERPARTY_LEGAL_LEI` **exist** in every file with the same type. Still to confirm with operations that this is the key they use.
8. ~~`BUSINESS_DATE` type.~~ **Closed (2026-10-19):** DATE; `ODIN_BUSINESS_DATE_FORMAT` is not needed.
9. **Real volume:** 4.06M distinct breaks on 12/10. Confirm with operations whether it is the same universe they see in the app (section 1 says 1–2M/day). It is the first number they will challenge in the demo.
10. ~~Conflicting keys.~~ **Closed (2026-10-19):** 0 conflicts on 12–15/10 with the corrected key. The 123 measured before came from synthetic data.
11. **Semantics of `BNPP_GLOBAL_BUSINESS_LINE`** vs. the planned "business line of the counterparty CRDS code". Confirm with the data mart team before showing it as a dimension.
12. Align the types of the `BNPP_*` columns across the per-asset-class exports (requested from the team; does not block the demo).
13. Load 13–15/10 to validate `breaks_dod` and the package fields hypothesis.
14. ~~Break key with a NULL `UTI`.~~ **Solved (2026-10-19):** the identifier comes in `PROPRIETARY` when `UTI` is missing; key = `COALESCE(UTI, PROPRIETARY)`. **Effect still to measure:** rebuild + profile of 12/10. Expected: `dup_factor` ≈ 1.0, `distinct_breaks` close to 4.5M and far fewer `conflicting_keys`. If so, the duplication fix requested from the team on 2026-10-16 can be cancelled.
    - **Measured with real data only (12–15/10, 20 files from S3, 5 asset classes per day):**

      | business_date | raw_rows = distinct_breaks | distinct_positions | conflicting_keys | dup_factor |
      |---|---|---|---|---|
      | 2026-10-12 | 4,526,560 | 299,012 | 0 | 1.0 |
      | 2026-10-13 | 2,344,311 | 295,510 | 0 | 1.0 |
      | 2026-10-14 | 2,305,762 | 289,676 | 0 | 1.0 |
      | 2026-10-15 | 2,336,183 | 293,019 | 0 | 1.0 |

      **Zero duplicates and zero conflicts on every day.** All the "duplication" and all the "conflicts" came from the key without `PROPRIETARY`. The 2026-10-16 request to the team can be cancelled. The dedup stays as a safeguard.
    - ⚠️ **Earlier numbers contaminated:** an intermediate measurement of 12/10 (304,012 positions, 123 conflicts, ~4.54M breaks, combinations covering 32.8%) mistakenly included the synthetic data of 12/10 (+5,000 positions; the 123 conflicts were the ones injected by the generator). **Ignore those values.** Exact cause unknown: probably a glob that picked up synthetic 12/10 files together with the real ones. Rule: always check `.env` and the list of files (`Get-ChildItem data -Recurse -Filter *.parquet`) before measuring.
    - **Normal days (13–15/10, real data only):**
      - **Stable top 10 on 13 and 15/10** (the list for the rules of days 3–5): VALUATION_AMT (~166–172k), VENUE_OF_EXECUTION, UNIQUE_PRODUCT_ID, ISIN, VALUATION_CCY, SETTLEMENT_CCY_1, PRODUCT_CLASSIFICATION, DELIVERY_TYPE, FLOAT_RATE_LEG2_IDENTIFIER, SPREAD_LEG2_TYP (~62k). Replaces the 12/10 list (atypical).
      - **Package fields stable and outside the top 10:** PCKG_TRANS_SPREAD_TYP 27–28k/day on 12–15/10. Not a peak; also not in the 10.
      - **`breaks_dod` 15 vs 14/10:** all 20 top fields vary between +0.2% and +3.0%. Breaks are a stable stock carried from day to day, not a new flow.
      - ⚠️ **Corrected on 2026-10-19 (see 3.1.2):** read `bnpp_null` / `cpty_null` with caution. **Key health (13/10):** null_uti 0; null LEIs 0; same_lei 0; **bnpp_null 447,015 (19%); cpty_null 138,644 (5.9%)**. The "CPTY null = 69%" pattern measured before was 12/10 with the old key and does not apply to normal days.
      - **No duplication per position:** in the positions with the most rows, raw_rows = n_fields and 1 trade number (at most ~37 fields per position).
      - **Field combinations (13/10):** the first 20 cover 65,751 of 295,510 positions (22.3%). Long tail → the cluster unit is the break, not the position.
      - **Correlated groups confirmed** (they always appear together in the combinations): product (UNIQUE_PRODUCT_ID + ISIN); valuation (VALUATION_AMT + VALUATION_CCY); package (the 3 PCKG_*); confirmation (CONFIRMATION_TIMESTAMP + CONFIRMED); and a trio DELIVERY_TYPE + FLOAT_RATE_LEG2_IDENTIFIER + SETTLEMENT_CCY_1. The most frequent combination (8,029 positions) joins 10 fields, including EXCHANGE_RATE1, FWD_EXCHANGE_RATE and SETTLEMENT_CCY_1/2 (FX forwards profile). Implication: rules per family of fields, not per isolated field.
    - **12/10 has twice the other days** (4.5M vs ~2.3M), with the same number of positions (~300 thousand). So the volume per position is double. Understand why (Monday with the weekend backlog? reprocessing?) before using 12/10 as a reference in the demo. Hint: with the old key, 12/10 had cpty_null in 69% of the breaks, vs 5.9% on 13/10. The ~2.2M extra breaks may almost all be the counterparty without a value (e.g. one side of the DTCC report missing that day). **Confirmed (2026-10-19), with real data only:** 12/10 has cpty_null = 3,168,040 of 4,526,560 (70%) and bnpp_null 344,010, vs 138,644 (5.9%) cpty_null on 13/10. Breaks with CPTY populated are even fewer on 12/10 (~1.36M) than on 13/10 (~2.2M). Positions on 12/10 reach ~61 breaking fields (max. ~37 on 13/10): whole fields without a value on the counterparty side.
      - **Conclusion:** 12/10 is an anomalous day (counterparty side missing for a large part of the trades). **Exclude it from the demo and the backtest**; warn whoever runs the DTCC feed.
      - ⚠️ **Corrected on 2026-10-19 (see 3.1.2):** the cause of 12/10 is not explained. **Opportunity for the demo:** a quality alert "cpty_null went from ~6% to 70%" would have detected this automatically.
      - Some top positions on 12/10 have 0 `BNPP_TRADE_NUMBER` (internal enrichment missing); to measure when the trade number is used.
    - **Top 10 with the corrected key (12/10, distinct breaks):** VALUATION_AMT 206,697; VENUE_OF_EXECUTION 175,033; VALUATION_CCY 158,384; UNIQUE_PRODUCT_ID 147,030; ISIN 132,397; CLEARING_OBLIGATION 120,406; PRODUCT_CLASSIFICATION 110,474; EXPIRATION_DATE 102,159; DELIVERY_TYPE 100,520; EFFECTIVE_DATE 95,763. Sum ≈ 1.35M (~30% of the breaks).
      - Same order as before the correction; the package fields stay out. The valuation (AMT/CCY) and product (UPI/ISIN/CFI) groups are all in the top 10.
      - **This is the candidate list for the rules of days 3–5**, not the one in section 4 (which had the 3 package fields). Confirm with 13–15/10: if the package fields only rise on one of those days, it is a one-off peak, not a structural field.
    - Open: is `PROPRIETARY` the same identifier the counterparty reports, or an internal ID? Only affects the UI label.
15. ~~The field combinations section of the profile did not appear.~~ **Solved (2026-10-19)** with the corrected key (the giant groups without a UTI were the probable cause).
16. **Persistence — measure with real data:** `npm run metric -- persistence --date 2026-10-14` and `--date 2026-10-15` (total and `--dims breaking_field`), and `npm run profile -- --date 2026-10-15` ("Identifier change" section). First run of the SQL on DuckDB: it was only validated on SQLite (the npm registry was not reachable in the development environment).
17. ~~**Identifier change between days**~~ **Measured 14→15/10:** 3,505 new positions, **0** with an identifier change. It does not inflate persistence; repeat if days with many new positions show up. Original text: **Identifier change between days** (PROPRIETARY → UTI, or corrected UTI): inflates "new" and "resolved". If `id_changed_positions` is relevant vs `new_positions`, review the persistence key (e.g. match by trade number).
18. **Phase 2 of persistence:** needs the history schema (question 2): grain (one row per break and per day, or per categorisation event?), categorisation date and the reported values at that moment.
19. **`_SUCCESS` check** in `build:db` (section 3.1.1): not implemented yet. Today an incomplete S3 copy goes in without warning.
20. Exact version of `@duckdb/node-api` installed on the office PC (`npm ls @duckdb/node-api`), to pin in `package.json`.
21. ~~**Impact of postponing the categorisation on the approved plan.**~~ **Closed (2026-10-19):** criteria revised (see decision log). Original text: without history there is no reference ID suggestion with confidence, no backtest (1st success criterion) and no real inheritance. Confirm whether the demo becomes "explanation of the break by the rules + breaks → clusters reduction factor + inheritance potential", and which criterion replaces the backtest.
22. ⚠️ **Corrected on 2026-10-19 (see 3.1.2):** wrong premise; kept as a record. **`cpty_null` — it is 13/10 that stands out:** 14/10 = 527,447 of 2,307,763 (22.9%; `bnpp_null` 481,265, 20.9%); 15/10 = 535,736 of 2,335,182 (22.9%; `bnpp_null` 21%). Recorded before for 13/10: 138,644 (5.9%). Hypotheses: 13/10 has the CPTY more populated (atypical day) or the 13/10 value was measured on another version of the data. Repeat the 13/10 profile and check `persistence --date 2026-10-14` (if 13/10 is real, ~390 thousand "changed" breaks CPTY populated → null).
23. **Totals different from the recorded ones:** 15/10 = 2,335,182 (before 2,336,183, −1,001); 14/10 = 2,307,763 (before 2,305,762, +2,001). "Round" differences on two days: either the file copy changed after the first measurements, or the values were mistyped. Confirm with `Get-ChildItem` + `data_quality --from 2026-10-13 --to 2026-10-15` and fix the table of question 14.
24. **What do `BNPP_REPORTED` / `CPTY_REPORTED` contain?** (flag, partial value, something else?) Decides whether they are of any use in the demo.
25. **DTCC file:** top 20 mapping validated (see 3.2). **Next (Ordep, 2026-10-20): validate the 179 pairs** with `map-fields --all-pairs` (statuses: ok / no differences / differences without break / breaks with equal values / breaks not found; `BREAKING_FIELD` without a pair). Then `--explain` of the pairs with differences without a break. Also: S3 path and `_SUCCESS`; `REFERENCE_DATE` vs `BUSINESS_DATE`; 6,277,763 vs 6,271,763 rows.
26. ~~**Align the break key with production's.**~~ **Done (2026-10-20).** Still to confirm with real data: `build:db` + `data_quality` 13–15/10 with the same totals and 0 conflicts.
27. ~~**BNPP side in each break.**~~ **Closed (2026-10-20, Ordep):** BNPP = party 1 = `REPORTING_COUNTERPARTY_LEI` = `TP1_`; counterparty = party 2 = `TP2_`.
28. ~~Mapping of the 3 fields without a row.~~ **Closed (2026-10-20):** SPREAD_LEG2_TYP → 2.109, MASTER_AGREEMENT_VRSN_V → 2.36, SETTLEMENT_DATE → 2.46; table 3.3.1 confirmed.
29. ~~Reference lists.~~ **Closed (2026-10-20):** not used; TP1_/TP2_ fields only. Sub-rules depending on a list = "not verifiable".
30. ~~Internal rules.~~ **Closed (2026-10-20):** they are the same ESMA rules; there is no separate internal catalog.
31. **Mapping file vs real columns:** 134 rows vs 179 pairs in the DTCC file; at least one name differs (`MASTER_AGREEMENT_VRSN` vs `_V`). Check with `map-fields --all-pairs`.
32. **Run the engine with real data:** `npm run rules -- --date 2026-10-15` (verdicts + suspect rules). First run on DuckDB (only tested on SQLite).
33. **Spread notation codes** (`SPREAD_LEG2_TYP`: possible values) — without them the 2109 rules stay not verifiable and the ~62 thousand breaks of that field come out `no_verifiable_rules`.
34. ~~Step 3 of the plan.~~ **Done (2026-10-20):** 409 codes; reduced to 274 (TP1_/TP2_ fields only). Still to run with real data and review the suspect rules (probably different enum codes in the DTCC file, like CONFIRMED).
35. **Future requirement — data quality:** validate every transaction of the DTCC file (not only the breaks) with the same rules engine; includes the daily quality alert.
36. **Real CONFIRMED codes in the DTCC file** (rule 2029-01 violates in 93% of the breaks on both sides): `npm run describe -- "data/dtcc/**/*.parquet" --values TP1_CONFIRMED,TP2_CONFIRMED`. The file probably uses other codes; the same may happen in other enums.
37. **Coverage of the "explanation by the rules" criterion**: in the 1st run only ~1.3% of the breaks have a side identified. Review with Ordep what the demo promises (see 3.3.2).
38. ~~Rules comparing with common columns.~~ **Closed (2026-10-20, Ordep):** they become not verifiable (2002-02, 2003-05, 2028-03, 2032-03, 2045-05, 2077-04, 2078-04); the compiler also rejects references to common columns.
39. **What does an operations user do with the ~170 thousand VALUATION_AMT breaks in Excel?** (filter by counterparty, sort by value, bulk-categorise by some criterion?) Decides what screen 3 has to do faster. Take it to the meeting with operations.
40. **Real questions from operations** (10–15) to replace the chips in `config/questions.json`, which are the agent's test set. Now in English: confirm that operations will ask the agent in English.
41. ~~**1st run of the demo on the office PC.**~~ **Done (2026-10-22, Ordep):** Vite build, Express and DuckDB run together on the office PC; all three screens work (after the Query fix). `/api/keys` drill-down on VALUATION_AMT (Transactions view, 15/10): **382 ms**. Still to record: the "Unexplained by the rules" % and the Key verdict table of `npm run rules`. Original text: **1st run of the demo on the office PC:** `npm install` (Express, React, Vite, `@vitejs/plugin-react` through Artifactory); `npm run rules` for 13, 14 and 15/10 (writes `key_summary`); `npm run build`; `npm start`. Measure the time of `/api/keys` with a field filter on VALUATION_AMT (join `key_summary` × `break_verdict`, ~170 thousand). The frontend was only built with esbuild and tested on SQLite with synthetic data; Vite, Express and DuckDB have never run together.
42. **CSV export** of the filtered Key list: left out of the plan. Operations live in Excel, and they will probably ask for it in the first demo.
43. **Where the demo runs:** assumed `localhost` on the presenter's PC, without authentication. To confirm.
44. **The synthetic generator does not create the DTCC file:** with synthetic data `npm run rules` cannot run and the UI has no dates. To develop the UI outside the office, also generate a synthetic DTCC file (TP1_/TP2_ of the fields in break).
45. **DTCC file only for 15/10 on the office PC** (confirmed on 2026-10-21): `npm run rules -- --date 2026-10-13` fails because the DTCC file is missing. Copy the 13 and 14/10 DTCC files from S3 (only folders with `_SUCCESS`) to `data/dtcc/{asset_class}/{date}/` and run `rules` for those dates. No need to repeat `build:db`. Until then the demo only has 15/10 (the change KPI compares with 14/10 through the breaks, which exist).
46. **The project on the PC came from the GitHub zip** (`Odin_regulatory-main`), not from `git clone`: `git pull` does not work, and `.env`, `config/local.json` and `data/` have to be copied by hand. Move to `git clone`.
48. **Order of the next phase** (asked on 2026-10-22, not answered): (a) agent first (gateway + `list_metrics`/`query_metric` + free text on screen 1), then knowledge RAG as a second tool, server last — **Claude's recommendation**: it unblocks the presentation and RAG is only useful with an agent; (b) RAG first (upload + indexing + search, no agent yet); (c) server first (authentication, data off the PC), then agent and RAG on the server.
49. **Internal LLM gateway:** format (Anthropic Messages / OpenAI / own), tool-calling support, and **whether an embeddings model is available** (Claude has no embeddings API). Without embeddings, the RAG can start with lexical/BM25 search in OpenSearch (works well on regulatory documents full of codes and field names).
50. **OpenSearch:** is there a cluster available to the team (version, k-NN plugin, authentication, who operates it, network access from the app server)?
51. **Knowledge upload governance:** who may upload, which document classifications are allowed (no client data?), versioning and deletion, audit of uploads, file types (PDF, DOCX, XLSX, MD).
52. **Server deployment:** which servers (Windows/Linux, on-prem/cloud), SSO for authentication, entitlements (the drill-down shows UTIs/LEIs), where the data lives (Parquet on the server, S3 via DuckDB `httpfs`, or ClickHouse), HTTPS, multi-user. Revokes the "localhost, no authentication" assumption (q. 43).
53. **Result of the 15/10 comparison with production** (colleague of Ordep): agreement per verdict/field, cases where the tool is wrong. Counts only.
47. **After the English migration (2026-10-21):** the existing `data/odin.duckdb` has rule tables with Portuguese identifiers. The first `npm run rules` drops them; run it again for every date (15/10 today, 13–14/10 once the DTCC files are there). `build:db` does not need repeating.

## 7. Current status
- **Done (2026-10-16):** project skeleton.
  - Configuration with column mapping.
  - Dialect layer and logical model (`breaks_raw`, deduplicated `breaks`).
  - Semantic layer with the 6 metrics; `reference_id_distribution` is pending the history schema.
  - Audit log (`logs/audit-*.jsonl`).
  - Synthetic data generator (correlated groups, fan-out, conflicts, equal LEIs).
  - Profiling script.
  - Automated tests (`npm test`; 16 since 2026-10-19); the SQL is validated against SQLite with expectations computed in JS.
- **Done (2026-10-19):** validation on the office PC (Windows x64, Node v24.15.0).
  - `npm install` works after excluding the internal Artifactory from the proxy (see README, "Known issues").
  - `npm test` 15/15; full synthetic smoke test without errors. The `src/db/duckdb.js` adapter worked unchanged; the dedup and the profile detect the injected fan-out, conflicts and equal LEIs.
  - First `build:db` with real data (12/10, 5 files, 13 s). Only `config/local.json` was needed, for `business_line`. `data_quality` and `breaks_dod` OK (DoD without comparison: only one day loaded).
- **Done (2026-10-19, afternoon):** 12/10 profile with key health and duplicated positions. Finding: the excess rows come mostly from NULL UTIs, and the dedup collapses them (question 14).
- **Done (2026-10-19):** key with `COALESCE(UTI, PROPRIETARY)`, validated with real data for 12–15/10 (20 files from S3): dup_factor 1.0 and 0 conflicts on every day; the synthetic generator now has ~10% of positions with `PROPRIETARY` only; new test (16 tests).
- **Done (2026-10-19, end of day):** 12–15/10 loaded (real data only); top 10 of normal days closed; 12/10 confirmed as anomalous (70% cpty_null); `profile` hides UTIs/LEIs by default (17 tests). **Days 1–2 of the plan closed.**
- **Done (2026-10-19, afternoon session):** `persistence` metric (phase 1), designed in grill-me mode and approved.
  - `src/semantic/calendar.js` (previous available day with excluded dates); `excludedDates` in the config; `breaks_dod` now skips 12/10.
  - `profile` with a diagnosis of identifier changes between days (aggregates only).
  - Synthetic generator with changed breaks, resolved fields and PROPRIETARY → UTI trades.
  - 24 tests (SQLite). The 15/10 profile runs on DuckDB (identifier diagnosis: 0 changes). **The `persistence` metric output is missing.**
- **Correction (2026-10-19, late afternoon):** the BNPP/CPTY values are not in the data mart, they are in the DTCC file (3.1.2). `persistence` is only reliable for the key part (new / resolved / continues); "same" vs "changed" suspended. Questions 24–26.
- **Done (2026-10-20):** break key = production key (UTI and PROPRIETARY separate, + REPORT_SUBMITTING_ENTITY and asset class); 26 tests. **Needs `build:db` on the office PC.**
- **Done (2026-10-20):** `npm run map-fields` (BREAKING_FIELD → TP1_/TP2_ mapping + confusion matrix per field, counts only); `ODIN_DTCC_GLOB`; 30 tests.
- **Done (2026-10-20):** mapping validated with real data (top 20 = same name, exact comparison reproduces 100% of the breaks); `map-fields --explain` for the valuation exceptions.
- **Done (2026-10-20):** `map-fields --all-pairs` (validation of the 179 pairs in batches of 20; counts CSV in `data/reports/`); 31 tests.
- **Done (2026-10-20):** rules Excel read; mapping of the top 20 → ESMA items (3.3.1), 17 direct and 3 to confirm; check types A/B/C/L.
- **Done (2026-10-20):** rules engine, steps 1–2 of the plan: `config/rules/field-map.json` (174 items: 128 with TP, 6 common, 40 without columns), `config/rules/emir-vr.json` (54 VR codes of the top 20: 30 verifiable, 14 partial, 10 not verifiable), DSL → SQL compiler (`src/rules/`), `npm run rules` (`--stats`), `rule_results` and `break_verdict` tables; data mart breaks only, each rule on the breaks of its field; 41 tests. 1st real run on 15/10 (see 3.3.2).
- **Done (2026-10-20, afternoon):** step 3 (409 VR codes), `rules:sample` to validate 10 breaks of 15/10; 43 tests.
- **Done (2026-10-20, late afternoon):** classification validated by Ordep on the sample; `break_detail` with ESMA field, TP1/TP2 values and error text (`src/rules/describe.js`); 44 tests.
- **Done (2026-10-20):** rules engine closed (steps 1–4); `rule_verdict` metric in the semantic layer. Validation with production data: Ordep.
- **Done (2026-10-20, evening):** demo backend + frontend (plan 2.1, designed in grill-me and approved).
  - `npm run rules` writes `key_summary`; `key_verdict` and `field_combinations` metrics (10 metrics in the catalog).
  - `src/server/`: `api.js` (logic), `app.js` (Express), `dbpool.js` (READ_ONLY, short-lived connection, lock → 503), `tools.js` (agent tool schemas). `npm start`, `npm run dev`, `npm run build`.
  - `web/` (React + Vite): top bar with jurisdiction, date, rules version and 4 KPIs; Query screen (chips + advanced query, cards with table/chart/SQL/"see breaks"), Top 10 (Δ, clickable verdict bar, % side identified), Drill-down (combinations → transactions → all breaks of the Key, with "copy key"). Drill-down state in the URL (`#/drill?...`), which is the format of the `open_drilldown` tool.
  - Verified end to end with synthetic data on SQLite (esbuild + headless browser, no console errors). **Not tested with Vite, Express or DuckDB** (the npm registry is not reachable in the development environment): question 41.
- **Done (2026-10-21):** `npm run rules` diagnoses a missing DTCC date. On the office PC: project started from the zip in a new folder; `build:db` OK; DTCC file only for 15/10 (questions 45–46).
- **Done (2026-10-21):** **whole application in English** (code, identifiers, database schema, UI, API/CLI messages, metric catalog, agent tools, rules config, tests, README, CLAUDE.md). Legacy rule tables are dropped by `npm run rules` (question 47). 54 tests. UI re-verified with synthetic data (headless browser, no console errors).
- **Fixed (2026-10-22):** Query screen crashed on the office PC when clicking a suggested question ("TypeError: G is not a function"). Cause: effects written as `useEffect(() => expr)` return `expr`; recent Chrome/Edge make `scrollIntoView` return a Promise, which React then calls as the cleanup function. All effects now use braces. Also added an error boundary per screen and per answer card, `npm start` logs each API request, and the newest answer shows first. Rule for the frontend: **never return a value from an effect** (always `useEffect(() => { ... })`).
- **Done (2026-10-22):** demo validated on the office PC with real data for 15/10 (all screens, drill-down 382 ms). **Requirements and jurisdiction onboarding guide** written: `docs/requirements.md`.
- **Next steps:**
  0. **Next session (new chat, grill-me):** decide the order of the next phase (q. 48) and design it; inputs needed: gateway format and embeddings (q. 49), OpenSearch availability (q. 50), upload governance (q. 51), server constraints (q. 52).
  1. **Demo validated on the office PC (2026-10-22):** all screens working, drill-down 382 ms. Open: copy the 13–14/10 DTCC files (q. 45) and run `rules` for those dates; record the % unexplained.
  2. **Agent (next session, grill-me):** format of the internal LLM gateway (Anthropic Messages / OpenAI / own) and tool calling support. The tools already exist: `GET /api/tools`. Wire up the free text of screen 1; measure the translation against `config/questions.json`.
  3. **Validation with production data (Ordep):** `npm run rules` + `rules:sample`; fix the CONFIRMED rule (q. 36) with `describe --values`.
  4. **Meeting with operations:** universe ~2.3M/day (q. 9); is `PROPRIETARY` the identifier the counterparty sees?; 3–5 hard cases (q. 5); what they do in Excel (q. 39); their real questions, in English (q. 40); CSV export (q. 42).
  5. **Warnings:** cancel the duplication fix request (there is none); warn the DTCC feed owner about 12/10; pin the `@duckdb/node-api` version (q. 20).
  6. **To design later (grill-me):** grouping the divergences by BNPP × counterparty value pair (breaks → decisions reduction factor); persistence "same/changed" with TP1/TP2 values; data quality on the whole DTCC file (q. 35); tie-break with the TSR booking.
  - **On hold (categorisation postponed):** history schema, phase 2 of persistence, backtest.

### Start prompt for the next session (next phase: agent, knowledge RAG, server)
```
Context: "Odin Regulatory — EMIR Breaks" project, Node.js + DuckDB + React demo on EMIR reconciliation breaks (DTCC report).
Repo: github.com/pemanico/Odin_regulatory (branch main). Everything in the project is in English; we talk in Portuguese.

Before anything else, clone the repo and read CLAUDE.md, README.md and docs/requirements.md (approved plans in sections 2
and 2.1 of CLAUDE.md, decision log, open questions, current status and next steps in section 7).

Where we are (2026-10-22): rules engine closed; backend (Express, src/server/) + frontend (React + Vite, web/) running on my
office PC with real data for 15/10 (drill-down 382 ms). A colleague is comparing 15/10 with production; other dates are
paused. The agent tools already exist (GET /api/tools) but there is no agent yet; free text on the Query screen is disabled.

Goal of this session: plan the next phase in grill-me mode, starting with open question 48 (order: agent / knowledge RAG
with OpenSearch / server deployment). The RAG goal: upload internal knowledge documents through the web app, index them in
OpenSearch and give the agent a search_knowledge tool (cited excerpts, never break rows). I also want the application
running on servers (Node.js). Inputs I will bring: <gateway format + embeddings (q. 49)>, <OpenSearch availability (q. 50)>,
<server constraints (q. 52)>, <15/10 comparison result (q. 53)>.

Rules:
- I run the commands on the office PC and paste the results. You have no access to the data.
- Never paste or record row-level data (UTIs, LEIs, values). Aggregates only. If I paste identifiers by mistake,
  warn me and do not use them.
- New features: grill-me mode, one question at a time, plan approved before code.
- Whenever you change files in the repo, commit and push to main.
- At the end of the session, update the "Current status", "Decision log" and "Open questions" sections of CLAUDE.md.
```

## 8. Repository structure
```
config/default.json        physical -> logical column mapping, paths (override: config/local.json, .env)
config/questions.json      suggested questions of screen 1 = the agent's test set
docs/requirements.md       requirements and jurisdiction onboarding guide (principles, data contract, refactors R1–R10, checklist)
config/rules/              field-map.json (ESMA item -> TP columns) and emir-vr.json (VR rules in the DSL)
src/config.js              loads config + .env
src/db/dialects.js         engine-specific SQL (duckdb, sqlite for tests)
src/db/model.js            logical model, break key, breaks_raw/breaks (dedup)
src/db/duckdb.js           @duckdb/node-api adapter (only place tied to the driver)
src/semantic/catalog.js    certified metrics, allowed dimensions and filters
src/semantic/calendar.js   previous available day, excluded dates
src/semantic/compiler.js   structured request -> SQL (whitelist + safe literals)
src/semantic/runner.js     runs + audit
src/analysis/profile.js    exploratory queries (field combinations, duplication, keys)
src/analysis/fieldmap.js   BREAKING_FIELD -> TP1_/TP2_ mapping and validation (confusion matrix)
src/rules/                 compile.js (DSL -> SQL per side), sql.js (rule_results, break_verdict, break_detail, key_summary, legacy check), describe.js (error text), catalog.js
src/server/                api.js (API logic, framework-free), app.js (Express), dbpool.js (DuckDB READ_ONLY, short-lived connection), tools.js (agent tools)
src/synthetic/generate.js  synthetic data (SYNTH* identifiers)
scripts/                   CLIs: synthetic, build-db, metric, profile, describe (Parquet structure without data), map-fields, rules, rules-sample, serve, dev
web/                       React + Vite frontend (vite.config.js, src/App.jsx, src/views/{Query,Top10,Drill}.jsx, src/components/, src/theme.css)
test/                      node:test
```
