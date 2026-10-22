# Odin Regulatory — Requirements and jurisdiction onboarding guide

> **Audience:** whoever implements the next regulatory case (MiFID II, CFTC, SFTR, SEC, Canada…) on top of the EMIR demo, and whoever reviews it.
> **Status:** written on 2026-10-22 from the EMIR implementation (code, decisions and measurements in `CLAUDE.md`). EMIR is the worked example throughout.
> **Rule of thumb:** if a step below says "configuration", it must not need code. If it needs code today, it is listed in section 9 (refactors before the second jurisdiction).

---

## 1. What the platform does

Business users (operations) ask questions about **regulatory breaks** and get certified KPIs, tables and the evidence behind each break, without exporting to Excel.

For each jurisdiction the platform answers three questions:

1. **How many breaks, where, and how do they evolve?** — certified metrics over the breaks data mart (top fields, day-on-day change, per counterparty, persistence…).
2. **Which side is wrong, according to the regulator's validation rules?** — a deterministic rules engine evaluates each side of each break against the official validation rules.
3. **What does a given transaction look like?** — drill-down from a field to the transactions, and from a transaction to all its breaking fields with both reported values, the verdict and the rule violated.

An LLM agent (next phase) translates free-text questions into certified metric requests. **It never sees data rows.**

```
 Spark pipeline (production)                         Odin Regulatory
 ───────────────────────────                         ───────────────────────────────────────────────────────────
 Breaks data mart (long: 1 row/break)  ── Parquet ──▶ build:db ──▶ breaks_raw / breaks (dedup)   ─┐
 Side-by-side file (wide: TP1_/TP2_)   ── Parquet ──▶ (read in place)                            ├─▶ rules ──▶ rule_results
 Rules document (Excel, regulator)     ── manual  ──▶ config/rules/*.json (DSL, translated)      ─┘           break_verdict
                                                                                                              break_detail
                                                                                                              key_summary
                                                    semantic layer (certified metrics) ◀──────────────────────┘
                                                    API (Express) ──▶ UI (React)  /  agent tools (LLM, aggregates only)
```

---

## 2. Principles (non-negotiable for every jurisdiction)

| # | Principle | Why | Where it is enforced |
|---|---|---|---|
| P1 | **The LLM only sees aggregates** (schema, metric definitions, counts). Row-level data (UTIs, LEIs, values) is shown deterministically by the UI. | Confidentiality; volume; auditability. | `src/server/tools.js` (no tool returns rows); `/api/keys` is UI-only. |
| P2 | **Metrics are certified**: fixed grain, measure, dimensions and filters. The LLM picks from the catalog; it never writes SQL. | Same question → same number. | `src/semantic/catalog.js`, `compiler.js` (whitelist + validated literals). |
| P3 | **The rules engine is deterministic SQL**, not an LLM. | Volume (millions of breaks/day), audit, reproducibility. | `src/rules/`, `npm run rules`. |
| P4 | **Configuration, not code**: table/column names, paths, keys, rules. | Onboarding a jurisdiction must not fork the code. | `config/`, `.env`. *(Partially true today — see section 9.)* |
| P5 | **Standard SQL** (no engine-specific functions outside `src/db/dialects.js`). | DuckDB today, ClickHouse on S3 later. | `src/db/dialects.js`. |
| P6 | **Every request is audited** (request, SQL, row count, duration — never data). | Regulatory context. | `src/audit.js`, `logs/audit-<date>.jsonl`. |
| P7 | **No data in Git** (Parquet, CSV, Excel, databases). Chats and documents receive aggregates only. | Confidentiality. | `.gitignore`; `profile` hides IDs by default. |
| P8 | **Human validation**: the tool explains and suggests; operations decide. | Accountability. | No write-back to production systems. |
| P9 | **Everything in English** (code, identifiers, UI, docs). | BNP Paribas is international. | Decision 2026-10-21. |

---

## 3. Architecture and components

| Layer | Files | Responsibility | Jurisdiction-specific? |
|---|---|---|---|
| Configuration | `config/default.json`, `config/local.json`, `.env`, `src/config.js` | Physical → logical column mapping, paths, excluded dates | **Yes** (values) |
| Engine / dialect | `src/db/dialects.js`, `duckdb.js`, `sqlite.js` | SQL engine adapters | No |
| Logical model | `src/db/model.js` | Logical columns, break key, dedup view | **Partly** (key and column list are hardcoded) |
| Semantic layer | `src/semantic/catalog.js`, `compiler.js`, `calendar.js`, `literals.js`, `runner.js` | Certified metrics → SQL | Mostly no (dimensions list is EMIR-flavoured) |
| Rules engine | `src/rules/compile.js`, `sql.js`, `describe.js`, `catalog.js`, `config/rules/` | Validation rules per side, verdicts, detail per break, summary per transaction | **Yes** (rules, field map, side prefixes) |
| Analysis CLIs | `scripts/describe.js`, `profile.js`, `map-fields.js`, `src/analysis/` | Structure discovery, mapping validation, profiling | No (generic tools) |
| API | `src/server/api.js`, `app.js`, `dbpool.js`, `tools.js`, `scripts/serve.js` | Agent tools + UI endpoints | No (jurisdiction list hardcoded) |
| UI | `web/` (React + Vite) | Query, Top 10, Drill-down | No (labels are generic) |
| Tests | `test/` (node:test, SQLite) | SQL validated against expectations computed in JS | No |

**Runtime today:** Windows PC, Node ≥ 20 (v24 at the office), DuckDB file `data/odin.duckdb`, Parquet copied from S3, server on `localhost` without authentication.

---

## 4. Data contract for a new jurisdiction

Before writing any configuration, the following must be **known and written down** (answers go into `CLAUDE.md` section 3 for that jurisdiction).

### 4.1 Breaks data mart (long format — one row per break)

| Logical column | Required | EMIR physical column | Meaning |
|---|---|---|---|
| `rec_stat_id` | yes | `REC_STAT_ID` | Row id; the lowest one wins in the dedup |
| `business_date` | yes | `BUSINESS_DATE` (DATE) | Reporting/business date |
| `breaking_field` | yes | `BREAKING_FIELD` | Name of the field in break |
| key columns | yes | `REPORT_SUBMITTING_ENTITY`, `REPORTING_COUNTERPARTY_LEI`, `OTHER_COUNTERPARTY_LEGAL_LEI`, `UTI`, `PROPRIETARY`, `C_PRIMARY_ASSET_CLASS` | Production key of a transaction (see 4.3) |
| `bnpp_value`, `cpty_value` | yes (legacy) | `BNPP_REPORTED`, `CPTY_REPORTED` | ⚠️ In EMIR these are **not** the field values (see 4.2) |
| dimensions | optional | `C_PRIMARY_ASSET_CLASS`, `BNPP_GLOBAL_BUSINESS_LINE`, `BNPP_ACTIVITY_L1..L4`, `REC_CATEGORY`, `PAIRING`, `RECONCILIATION`, `VALUATION_RECONCILIATION`, `BNPP_COUNTERPARTY_CRDS_CODE`, `BNPP_TRADE_NUMBER` | KPI/cluster dimensions |

Questions to answer:
- [ ] Source table and S3 path; one folder per `{asset_class}/{date}` with `_SUCCESS`?
- [ ] Type of the business date (DATE or text — if text, its format).
- [ ] **What is the production key?** (the exact `PARTITION BY` used by the production application). Measure it: `npm run describe -- "<glob>" --key COL1,COL2,…` must give distinct keys = rows per field and date.
- [ ] Can a trade have its identifier in more than one column (EMIR: `UTI` **or** `PROPRIETARY`, never both)?
- [ ] Are there duplicates? (`npm run metric -- data_quality` → `dup_factor` 1.0 and `conflicting_keys` 0 expected.)
- [ ] Daily volume (EMIR: ~2.3M distinct breaks/day in ~295k transactions; one anomalous day with 4.5M).
- [ ] Anomalous dates to exclude (`excludedDates`).

### 4.2 Side-by-side file (wide format — one row per transaction, both sides' values)

In EMIR this is the **DTCC reconciliation report**: `TP1_<field>` (BNPP = reporting counterparty) and `TP2_<field>` (other counterparty) for 179 fields, plus the same key columns. **It is the only source of the values of each side**; the data mart only says *which* field is in break.

Questions to answer:
- [ ] Does the jurisdiction have such a file? Which columns hold "our" value and "their" value? (MiFID transaction reporting, for instance, may compare **our report vs. the ARM/NCA feedback or vs. internal booking** — the "other side" may not be a counterparty.)
- [ ] Is "our side" always the same column (EMIR: TP1 = BNPP, always), or does it depend on the row?
- [ ] Does it carry the **same production key** as the data mart, and is the key unique in the file? (EMIR: yes, 1:1 join.)
- [ ] Do the field names match `BREAKING_FIELD`? Validate with `npm run map-fields -- --date <d> --all-pairs`:
  `pct_found ≈ 100` (breaks found by key), `pct_break_diff ≈ 100` (breaks have different values), `pct_nobreak_diff ≈ 0` (no difference without a break). A high `pct_nobreak_diff` means the matching applies tolerances/normalisation that the rules must know.
- [ ] Is it full (every reported transaction; EMIR: 6.3M rows/day) or only breaks?

### 4.3 Grain and keys

- **Break** = business date + production key + breaking field. Grain of every certified "breaks" metric.
- **Transaction (Key)** = business date + production key (without the field). Grain of the drill-down and of `key_summary`.
- Both sides of a NULL-able key column are compared with `COALESCE(col, '')` (standard SQL, NULL-safe).

### 4.4 Rules document

In EMIR: the Excel `EMIR-Refit_Reconciliation status matching.xlsx` (ESMA validation rules `EMIR-VR-xxxx-nn`; internal rules = ESMA rules). Questions:
- [ ] Source document, version and owner.
- [ ] Code format of the rules (EMIR: `EMIR-VR-dddd-dd`).
- [ ] Mapping item (e.g. "2.22") → field name → column suffix in the side-by-side file.
- [ ] Rule levels: (1) format/domain, (2) conditions between fields of the same side, (3) external reference data (GLEIF, MIC, ISO 4217, ANNA DSB), (4) lifecycle across reports. **Only 1 and 2 are checked record by record**; 3 and 4 are "not verifiable" unless the reference data is loaded.

---

## 5. Rules engine requirements

### 5.1 Configuration files (`config/rules/`)

- **`field-map.json`** — one entry per rules-document item:
  `{ "2.22": { "field": "Valuation currency", "tp": ["VALUATION_CCY"] } }`
  `tp` = column suffixes in the side-by-side file; `common` = a column shared by both sides (key columns, reporting timestamp); empty `tp` = field not in the file (its rules are not verifiable). `source` flags manual corrections.
- **`<jurisdiction>-vr.json`** — one entry per rule code, in the declarative DSL documented at the top of `src/rules/compile.js`:
  ```json
  { "code": "EMIR-VR-2019-01", "item": "2.19", "when": { "eq": ["2.47", "CASH"] }, "check": { "required": true }, "status": "verifiable" }
  ```
  - `when`: optional condition on fields **of the same side** (`eq`, `ne`, `in`, `not_in`, `populated`, `blank`, `all`, `any`, `not`).
  - `check`: `required`, `blank`, `enum`, `not_in`, `regex`, `date`, `timestamp`, `year`, `decimal`, `compare`, `count_populated`, `all`, `if`, `equals_any`, `not_equal`.
  - `status`: `verifiable` | `partial` (a `note` must say what is not checked) | `not_verifiable` (with a `note`).
  - Rules are translated from the rules document by hand/assistant; **the original text is not copied** into the repo.

### 5.2 Evaluation semantics

- Each rule is evaluated **separately for each side**, with that side's own fields only (BNPP with `TP1_*`, counterparty with `TP2_*`).
- **Scope:** only the data mart breaks, and each rule only on the breaks of **its own** field. Validating the whole side-by-side file is "data quality" (future requirement).
- Format checks on typed Parquet columns (DATE, TIMESTAMP, DECIMAL) are not verifiable (the original format is lost); `decimal` on a numeric column checks sign and magnitude only.
- Value checks (enum, regex, decimal…) only apply to populated values; `required`/`blank` handle emptiness.

### 5.3 Verdicts

Per break (`break_verdict.verdict`):

| Verdict | Meaning |
|---|---|
| `bnpp_only` | Only our side violates a rule |
| `cpty_only` | Only the other side violates a rule |
| `both` | Both sides violate rules |
| `divergence` | Both sides comply with the verifiable rules; **the rules do not say who is wrong** |
| `no_verifiable_rules` | The field has no verifiable rule with the available data |

Per transaction (`key_summary.key_verdict`): `bnpp` (only our side has errors), `counterparty` (only the other side), `mixed` (errors on both sides, in different fields or a `both` field), `unexplained` (no field with a side identified).

**Expectation management (measured in EMIR, 15/10):** ~47% of breaks are `divergence` and ~53% `no_verifiable_rules`; only ~1.3% have a side identified. Trade repositories already validate submissions, so values that reach reconciliation are usually valid. **The rules explain little on their own**; the value of the tool is triage and evidence (fields that break together, both values side by side). Tie-breaking with internal booking data (EMIR: `TSR_*` columns) is a future requirement.

### 5.4 Validation of a rules catalog

1. `npm run rules -- --date <d> --stats` → violation rate per rule and side.
2. **Suspect rule** = violates on **both** sides in > 5% of the breaks of its field (a real error is usually one-sided; a wrong translation fails on both). Review each suspect (EMIR example: `CONFIRMED` codes in the file differ from the regulation's).
3. `npm run rules:sample -- --date <d> --n 10` → local CSV of 10 breaks spread across verdicts; a business user marks each one correct Y/N. The result (counts only) is recorded in `CLAUDE.md`.

### 5.5 Outputs (tables in the DuckDB database, rebuilt per business date)

| Table | Grain | Content |
|---|---|---|
| `rule_results` | violation | key, item, field, side, rule code |
| `break_verdict` | break | key, field, counts of violations per side, codes, verdict |
| `break_detail` | break | key, `field_label` ("2.22 Valuation currency"), `bnpp_value`, `other_cpty_value`, `verdict_text`, `bnpp_error`, `other_cpty_error` (rule text) |
| `key_summary` | transaction | `key_id` (synthetic, never the real key in URLs), number of fields, field combination `|A|B|`, counts per verdict, Key verdict |

---

## 6. Semantic layer (certified metrics)

Generic metrics (work for any jurisdiction once the data contract is met): `breaks_by_field`, `breaks_dod`, `top_fields`, `breaks_by_counterparty`, `persistence`, `data_quality`, `rule_verdict`, `key_verdict`, `field_combinations`. Pending: `reference_id_distribution` (categorisation history schema missing).

Requirements for any new metric:
- Fixed grain and measure; allowed dimensions and filters listed in the catalog (whitelist).
- `business_date` filter required.
- Standard SQL only; validated against SQLite in `test/` with expectations computed in JavaScript.
- A clear English `description`: it is what the agent reads to choose the metric.
- Day-on-day metrics use the **previous available** business date, skipping `excludedDates`.

---

## 7. API, agent tools and UI

### 7.1 Endpoints

| Endpoint | For | Returns |
|---|---|---|
| `GET /api/meta` | UI | jurisdictions, dates with rules run, rules version |
| `GET /api/metrics` | agent tool `list_metrics` | metric catalog |
| `POST /api/query` | agent tool `query_metric` | aggregated rows + SQL |
| `GET /api/tools` | agent | tool schemas (`list_metrics`, `query_metric`, `open_drilldown`) |
| `GET /api/questions` | UI | suggested questions (= agent test set) |
| `GET /api/keys` | **UI only** | paginated transactions with filters |
| `GET /api/keys/:id?date=` | **UI only** | all breaks of one transaction |

`open_drilldown` returns only filters for the UI (`#/drill?...`). **No tool may ever return rows** (P1).

### 7.2 UI

Three screens, keyboard-driven, dense dark theme: **Query** (suggested questions + advanced builder; free text once the agent exists), **Top 10** (field, Δ vs previous day, verdict bar, % side identified), **Drill-down** (field combinations → transactions → all breaks of a transaction). A KPI strip (breaks, Δ, transactions, % unexplained) and a jurisdiction selector sit on top.

### 7.3 Suggested questions = agent test set

`config/questions.json`: each entry is a question in English and the exact structured request expected. When the agent exists, its translation of each question is compared with the expected request — this is the acceptance criterion for the agent. **Replace the initial questions with real ones from operations.**

---

## 8. Non-functional requirements

| Area | Requirement | EMIR reference |
|---|---|---|
| Performance | Metrics and drill-down answer in < 1 s on a desktop | drill-down of VALUATION_AMT (~170k breaks): 382 ms |
| Volume | Millions of breaks/day; the side-by-side file may be several times larger | 2.3M breaks/day; 6.3M DTCC rows/day |
| Concurrency | Scripts may write while the server reads | DuckDB READ_ONLY, short-lived connection per request; lock → HTTP 503 |
| Security | Localhost only, no authentication (demo). **Server deployment requires SSO and entitlements** (row-level data in the drill-down) | open question |
| Audit | Every API request and metric run logged without data | `logs/audit-<date>.jsonl`; request log in the `npm start` console |
| Portability | Windows + PowerShell (office), Node ≥ 20 | see README "Known issues" |
| Browser | Recent Chrome/Edge; never return a value from a React effect | Query crash fixed on 2026-10-22 |
| Testing | `npm test` green; SQL validated on SQLite | 54 tests |

---

## 9. Refactors required before the second jurisdiction

Today the code assumes a single jurisdiction in several places. These must be done **once**, before onboarding MiFID/CFTC/SFTR, so that the next ones are configuration only:

| # | Today (EMIR-coupled) | Required |
|---|---|---|
| R1 | One `config/default.json` with `"jurisdiction": "EMIR"` (not used by the code) | `config/jurisdictions/<id>.json` with columns, key, globs, excluded dates, rules files; selected per request |
| R2 | Break key hardcoded in `src/db/model.js` (`POSITION_KEY`, `LOGICAL_COLUMNS`) | Key and logical columns read from the jurisdiction config |
| R3 | One DuckDB database with unprefixed tables (`breaks`, `break_verdict`…) | One database per jurisdiction (`data/<id>.duckdb`) or a `jurisdiction` column on every table — decide before R4 |
| R4 | Side prefixes hardcoded (`SIDES = { BNPP: 'TP1', CPTY: 'TP2' }` in `src/rules/compile.js`) | Side definition in config (prefixes or explicit column pairs; "our side" possibly per row) |
| R5 | Rules file path hardcoded (`config/rules/emir-vr.json` in `src/rules/catalog.js`) | Rules and field-map paths from the jurisdiction config |
| R6 | Rule code format hardcoded (`^EMIR-VR-\d{4}-\d{2}$` in `validateRules`) | Code pattern in config |
| R7 | Jurisdiction selector is cosmetic (`JURISDICTIONS` in `src/server/api.js`, only EMIR enabled) | API takes `jurisdiction` on every endpoint; selector drives the data; agent tools take it too |
| R8 | Metric dimensions list contains EMIR-flavoured columns | Dimensions per jurisdiction (catalog filtered by what the config maps) |
| R9 | `config/questions.json` is EMIR-only | Questions per jurisdiction |
| R10 | `build:db` does not check `_SUCCESS` | Refuse folders without `_SUCCESS` |

---

## 10. Onboarding checklist (step by step)

Commands are shown for EMIR; replace globs and dates. Paste only aggregates into chats or documents.

1. **Collect the data contract** (section 4) and write it into `CLAUDE.md`.
2. **Copy one normal day** of each source to `data/<source>/{asset_class}/{date}/` (only folders with `_SUCCESS`).
3. **Discover the structure:** `npm run describe -- "data/dtcc/**/*.parquet"` and the same for the breaks; measure the key with `--key`.
4. **Configure** the column mapping (`config/local.json` today; jurisdiction config after R1) and run `npm run build:db`.
5. **Check data quality:** `npm run metric -- data_quality --from <d1> --to <d2>` → `dup_factor` 1.0, 0 conflicts. Run `npm run profile -- --date <d>` (key health, field combinations).
6. **Validate the field mapping:** `npm run map-fields -- --date <d> --all-pairs`; fix the names that do not match with `--map FIELD=SUFFIX`.
7. **Translate the rules** into `field-map.json` + `<jurisdiction>-vr.json`; mark `partial` / `not_verifiable` with notes.
8. **Run and validate the rules:** `npm run rules -- --date <d> --stats`; review suspect rules; `npm run rules:sample` checked by a business user.
9. **Measure the expectation:** verdict distribution and % unexplained; agree with operations what the demo promises.
10. **Suggested questions:** collect real questions from operations into the jurisdiction's questions file.
11. **Run the UI:** `npm run build && npm start`; check Top 10, drill-down timing (< 1 s) and the Query screen.
12. **Record** decisions, measurements and open questions in `CLAUDE.md`; commit and push.

---

## 11. Out of scope today / next phases

- **Agent** (Claude via the bank's internal gateway, tool calling): uses the existing tools. Blocked on the gateway format (Anthropic Messages / OpenAI / own) and tool-calling support.
- **Knowledge RAG with OpenSearch**: upload of internal documents through the web app (rules documents, procedures, categorisation guidelines) → text extraction → chunking → indexing in OpenSearch → a `search_knowledge` agent tool returning cited excerpts (never break rows). Needs: an OpenSearch cluster, an embeddings model (or lexical/BM25 search first), upload governance (who uploads, document classification, deletion, versioning).
- **Server deployment**: authentication (SSO), entitlements, data on the server or read from S3 (DuckDB `httpfs` or ClickHouse), HTTPS, multi-user audit.
- **Categorisation**: reference ID suggestion from the history, inheritance between days (persistence phase 2), backtest — waiting for the history schema.
- **Data quality** on the whole side-by-side file, with daily alerts.

---

## 12. Glossary

| Term | Meaning |
|---|---|
| Break | One field that differs between the two sides of one transaction on one business date |
| Key / transaction | Production key without the field; one row of the side-by-side file |
| TP1 / TP2 | DTCC "trade party" 1 and 2; in BNPP's EMIR data TP1 = BNPP, TP2 = other counterparty |
| VR | Validation rule (ESMA: `EMIR-VR-dddd-dd`) |
| Divergence | Both values comply with the verifiable rules; the rules do not say who is wrong |
| Certified metric | Catalog entry with fixed grain, measure, dimensions and filters |
| Suspect rule | Violates on both sides in > 5% of its field's breaks — likely a translation error |
| Excluded date | Business date skipped in day-on-day comparisons (EMIR: 2026-10-12, anomalous) |
