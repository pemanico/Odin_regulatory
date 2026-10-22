# Odin Regulatory — EMIR Breaks

KPIs and assisted triage of EMIR reconciliation breaks (DTCC report), on data marts already processed by Spark.
Full context, approved plan, decisions and open questions: **[CLAUDE.md](CLAUDE.md)** (read it first).
Requirements and how to onboard a new jurisdiction: **[docs/requirements.md](docs/requirements.md)**.

> This repository holds code only. **Never** commit data (Parquet, CSV, Excel, DuckDB databases): `.gitignore` blocks them.

## Requirements
- Node.js ≥ 20 (the SQLite tests need Node ≥ 22.13; on older versions they are skipped)
- Access to the npm registry (directly or through the internal proxy) to install `@duckdb/node-api`, Express, React and Vite

## Getting the code
Use `git clone https://github.com/pemanico/Odin_regulatory.git` rather than the GitHub zip: with a clone, `git pull` updates the code.
`.env`, `config/local.json` and `data/` are not in Git: copy them from the previous folder when moving to a new one.

## Quick start (synthetic data)
```bash
npm install
npm test                                   # automated tests
npm run synthetic                          # generates data/synthetic/*.parquet (fake SYNTH* identifiers)
```
Create a `.env` file (copy `.env.example`) with:
```
ODIN_BREAKS_GLOB=data/synthetic/*.parquet
ODIN_EXCLUDED_DATES=
```
Then:
```bash
npm run build:db                           # creates data/odin.duckdb with breaks_raw and breaks (dedup)
npm run metric -- --list                   # available metrics
npm run metric -- top_fields --date 2026-10-12
npm run profile -- --date 2026-10-13
```
The synthetic generator does not create a DTCC file, so `npm run rules` and the web demo need real data.

## With real data
1. Copy the breaks table Parquet files to `data/breaks/`, with the S3 structure: `data/breaks/{asset_class}/{YYYY-MM-DD}/*.parquet`. They are all read together. Only copy folders with `_SUCCESS` (complete pipeline run); `build:db` does not check this yet.
2. In `.env`: `ODIN_BREAKS_GLOB=data/breaks/**/*.parquet` (the `**` matches the subfolders). If `BUSINESS_DATE` comes as `dd/mm/yyyy` text, also add `ODIN_BUSINESS_DATE_FORMAT=%d/%m/%Y`.
3. If the column names differ, fix the mapping in `config/local.json` (same structure as `config/default.json`; only the keys to change). Today the office PC needs `{ "columns": { "business_line": "BNPP_GLOBAL_BUSINESS_LINE" } }`.
4. `npm run build:db` and then `npm run profile -- --date <date>`. The profile hides UTIs and LEIs by default; `--show-ids` shows them, for on-screen use only (never paste that output). **This is the first step with real data:** it confirms duplication, keys and groups of correlated fields.

> `build:db` **deletes and recreates** `data/odin.duckdb`, including the rules engine tables. Always run `npm run rules` for every date afterwards.

## Structure of other Parquet files (e.g. the DTCC file)
`npm run describe -- "<glob>"` shows the number of files and rows, columns and types (separating `TP1_`/`TP2_` and asymmetric pairs) and rows per business date / asset class. `--key COL1,COL2` measures the uniqueness of a candidate key; `--all` also lists the `TP1_`/`TP2_` columns. It shows no values: safe to paste.

## Mapping `BREAKING_FIELD` → `TP1_`/`TP2_` (DTCC file)
Prerequisite: `build:db` done and one day of the DTCC file in `data/dtcc/{asset_class}/{date}/` (`ODIN_DTCC_GLOB`).
```bash
npm run map-fields -- --date 2026-10-15                 # top 20 fields
npm run map-fields -- --date 2026-10-15 --map FIELD=SUFFIX --map ...   # manual mapping of the ones whose names do not match
npm run map-fields -- --date 2026-10-15 --all-pairs     # validates the ~179 pairs; full CSV in data/reports/
npm run map-fields -- --date 2026-10-15 --explain VALUATION_CCY        # differences without a break by report status
```
For each field: `pct_found` (breaks found in the DTCC file by key), `pct_break_diff` (breaks with TP1 ≠ TP2; ≈100 = right suffix) and `pct_nobreak_diff` (transactions without a break with TP1 ≠ TP2; ≈0 = same comparison as Spark). Fields without a pair of the same name are shown with candidates, never mapped automatically. Counts only.

## Rules engine (ESMA validation rules per side)
Configuration in `config/rules/`: `field-map.json` (ESMA item → `TP1_`/`TP2_` columns) and `emir-vr.json` (one entry per VR code, DSL described in `src/rules/compile.js`).
```bash
npm run rules -- --date 2026-10-15           # writes rule_results, break_verdict, break_detail and key_summary; verdict per break/field and suspect rules
npm run rules -- --date 2026-10-15 --stats   # same + full table per rule (CSV always in data/reports/)
```
Detail per break (`break_detail` table and `data/reports/break-verdict-<date>.csv`, local only): production key, **field_label** (name in the rules document, e.g. "2.22 Valuation currency"), **bnpp_value** (`TP1_<field>`), **other_cpty_value** (`TP2_<field>`), verdict and **bnpp_error / other_cpty_error** (the format/condition rule violated, as text).
Manual validation: `npm run rules:sample -- --date 2026-10-15 [--n 10] [--field FIELD]` writes `data/reports/sample-<date>.csv` with the same columns + correct Y/N and comment. Local only.

Scope: the rules only run on the data mart breaks, and each rule only on the breaks of its own field. Validating the whole DTCC file is "data quality" (future requirement). Suspect rule = violates on both sides in > 5% of the breaks of its field.
Verdicts: `bnpp_only`, `cpty_only`, `both`, `divergence` (both sides comply with the verifiable rules) and `no_verifiable_rules`. The engine is deterministic SQL (DuckDB); it does not use the LLM. Counts only.

> **English migration (2026-10-21):** identifiers and columns changed from Portuguese to English. The first `npm run rules` after updating drops the old rule tables; run it again for **every** business date.

## Web demo (backend + frontend)
Prerequisites: `npm install` (also installs Express, React and Vite) and, **for every business date**, `npm run rules -- --date <date>`. `rules` writes the `key_summary` table used by the UI.
```bash
npm run build      # builds the frontend into web/dist (repeat after changing web/)
npm start          # http://localhost:3001  (port: ODIN_PORT; listens on localhost only, no authentication)
npm run dev        # development: API with --watch + Vite on http://localhost:5173
```
- **Screens:** `1` Query (suggested questions + advanced query, as a conversation thread; free text is for the agent), `2` Top 10 (field, Δ vs previous day, verdict bar, % with the side identified), `3` Drill-down (field combinations → transactions/Keys → all breaks of the Key with BNPP value = `TP1_<field>`, other cpty value = `TP2_<field>`, verdict and rule violated). Shortcuts: `1`/`2`/`3`, `j`/`k`, `Enter`, `Esc`, `/`, `n`/`p`.
- **The date selector only shows dates with `key_summary`** (rules run), outside `excludedDates`.
- **The database is opened READ_ONLY only during each request:** `npm run rules` and `build:db` can run while the server is up. If a request hits a write in progress, the UI shows "the database is being updated"; just retry.
- **Suggested questions:** `config/questions.json` (question → expected structured request). It is also the agent's test set.

| Endpoint | For | Returns |
|---|---|---|
| `GET /api/meta` | UI | jurisdictions (only EMIR enabled), dates with rules, rules version |
| `GET /api/metrics` | **tool `list_metrics`** | catalog of certified metrics |
| `POST /api/query` | **tool `query_metric`** | aggregated rows of a metric (with the SQL) |
| `GET /api/tools` | agent (future) | tool schemas (`list_metrics`, `query_metric`, `open_drilldown`) |
| `GET /api/questions` | UI | suggested questions |
| `GET /api/keys` | **UI only** | paginated transactions (Keys), with filters: `field`, `field_verdict`, `combo`, `key_verdict`, `asset_class`, `cp2_lei`, `trade`, `min_fields`, `sort`, `page` |
| `GET /api/keys/:id?date=` | **UI only** | all breaks of the Key (ESMA field, TP1, TP2, verdict, errors) |

**Architecture rule:** the agent only sees aggregates. `/api/keys` returns UTIs, LEIs and values and is **never** a tool. The `open_drilldown` tool only returns the screen 3 filters to the UI (the `#/drill?...` URL). Every request is logged in `logs/audit-<date>.jsonl` (parameters and row count, no data).

Verdict of a transaction (Key = production key without the field): `bnpp` (only fields with a BNPP error), `counterparty` (only counterparty errors), `mixed` (errors on both sides; a `both` field counts as mixed), `unexplained` (no field with the side identified).

## Metrics (semantic layer)
| Metric | What it answers |
|---|---|
| `breaks_by_field` | Distinct breaks per field (and other allowed dimensions) |
| `breaks_dod` | Change per field vs. the previous available business date |
| `persistence` | Breaks of D vs. D-1: same / changed / new / resolved. Potential for inheriting the categorisation, **not** a saving |
| `top_fields` | Top N breaking fields |
| `breaks_by_counterparty` | Breaks per counterparty LEI |
| `reference_id_distribution` | *Pending:* the schema of the categorisation history is missing |
| `rule_verdict` | Breaks per ESMA rules verdict (per field, asset class, counterparty); requires `npm run rules` |
| `key_verdict` | Transactions (Keys) per Key verdict (bnpp, counterparty, mixed, unexplained); requires `npm run rules` |
| `field_combinations` | Combinations of breaking fields in the same transaction, with the number of transactions; the `breaking_field` filter returns the ones containing the field |
| `data_quality` | Raw rows vs. distinct breaks, duplication factor, keys with conflicting values |

Examples:
```bash
npm run metric -- breaks_by_field --from 2026-10-12 --to 2026-10-15 --dims business_date,breaking_field
npm run metric -- breaks_by_counterparty --date 2026-10-15 --filter breaking_field=VALUATION_AMT
npm run metric -- breaks_dod --date 2026-10-15 --filter asset_class=COMMODITY
npm run metric -- data_quality --from 2026-10-12 --to 2026-10-15
npm run metric -- persistence --date 2026-10-15                       # day total
npm run metric -- persistence --date 2026-10-15 --dims breaking_field # per field
npm run metric -- top_fields --date 2026-10-15 --sql      # prints the generated SQL only
```
**Excluded dates:** day-on-day comparisons (`breaks_dod`, `persistence`) skip the dates in `excludedDates` in `config/default.json` (today `2026-10-12`, an anomalous day) and reject them as the requested date. For synthetic data, set `ODIN_EXCLUDED_DATES=` (empty) in `.env`.

Every run is logged in `logs/audit-<date>.jsonl` (request, SQL, row count, duration; no data).

## Known issues
- **`npm run rules` fails with "No DTCC transactions on <date> with a break in the data mart":** usually the DTCC file for that date is missing in `data/dtcc/`. The message lists the dates available on each side.
- **`npm run build` fails to install/run Vite:** `@vitejs/plugin-react` and `vite` come from Artifactory like the rest. If a package is missing, run `npm install` again and check the error. The frontend was only built with esbuild in the development environment; the first Vite build is on the office PC.
- **The UI says "No rules results yet"** or does not show a date: `npm run rules -- --date <date>` is missing (writes `key_summary`).
- **`Could not load @duckdb/node-api`**: run `npm install`.
- **DuckDB driver error after installing**: the `@duckdb/node-api` API is still evolving. The only file tied to the driver is `src/db/duckdb.js`; adjust it there (`DuckDBInstance.create`, `connect`, `runAndReadAll`, `getRowObjects`).
- **`npm install` returns `E403 Intranetbrowsingblocked`** on the internal Artifactory (`artifactory.cib.echonet`): npm is sending the intranet request through the internet proxy. Fix: `npm config set noproxy ".echonet,localhost,127.0.0.1"`. The `Unknown user config "always-auth"` warning is harmless.
- **Windows / PowerShell — `.env` ignored:** `echo ... > .env` writes UTF-16. Create it with `Set-Content -Path .env -Value "..." -Encoding ascii` (append lines with `Add-Content -Encoding ascii`).
- **Windows / PowerShell — `config/local.json` JSON error:** in PowerShell 5.1, `-Encoding utf8` writes a BOM. Create it in VS Code or with `[IO.File]::WriteAllText("$PWD\config\local.json", '<json>')`.
- **`Binder Error: Referenced column ... not found`** in `build:db`: the physical column name differs from `config/default.json`. Fix only that key in `config/local.json`. DuckDB reports one column at a time; to see the whole schema, run `DESCRIBE SELECT * FROM read_parquet('<file>')`.
