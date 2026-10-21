// Loads the configuration: config/default.json + config/local.json (optional) + .env + environment variables.
// Table names, columns and paths live here, never hardcoded in the rest of the code.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeExcludedDates } from './semantic/calendar.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Reads a simple .env file (KEY=VALUE). Does not override variables that are already set. */
export function loadDotEnv(path = resolve(ROOT, '.env')) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const [, key, raw] = m;
    const value = raw.replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

function absolute(p) {
  return p && !isAbsolute(p) ? resolve(ROOT, p) : p;
}

/** Returns the final configuration. `overrides` is for tests. */
export function loadConfig(overrides = {}) {
  loadDotEnv();
  let config = readJson(resolve(ROOT, 'config/default.json'));
  const localPath = resolve(ROOT, 'config/local.json');
  if (existsSync(localPath)) config = deepMerge(config, readJson(localPath));

  const env = process.env;
  config = deepMerge(config, {
    source: {
      ...(env.ODIN_BREAKS_GLOB ? { breaksGlob: env.ODIN_BREAKS_GLOB } : {}),
      ...(env.ODIN_DB_PATH ? { dbPath: env.ODIN_DB_PATH } : {}),
      ...(env.ODIN_DTCC_GLOB ? { dtccGlob: env.ODIN_DTCC_GLOB } : {}),
      ...(env.ODIN_BUSINESS_DATE_FORMAT ? { businessDateFormat: env.ODIN_BUSINESS_DATE_FORMAT } : {}),
    },
  });
  if (env.ODIN_EXCLUDED_DATES !== undefined) {
    // Comma-separated list; empty = no excluded dates (e.g. synthetic data).
    config.excludedDates = env.ODIN_EXCLUDED_DATES.split(',').map((s) => s.trim()).filter(Boolean);
  }
  config = deepMerge(config, overrides);
  // Compatibility: `uti_alt` (before 2026-10-20) was renamed to `proprietary`.
  if (config.columns?.uti_alt !== undefined) {
    if (config.columns.uti_alt) config.columns.proprietary = config.columns.uti_alt;
    delete config.columns.uti_alt;
  }
  config.excludedDates = normalizeExcludedDates(config.excludedDates);

  config.source.breaksGlob = absolute(config.source.breaksGlob);
  config.source.dbPath = absolute(config.source.dbPath);
  if (config.source.dtccGlob) config.source.dtccGlob = absolute(config.source.dtccGlob);
  validateConfig(config);
  return config;
}

const REQUIRED_COLUMNS = [
  'rec_stat_id', 'business_date', 'report_submitting_entity', 'uti', 'proprietary', 'cp1_lei', 'cp2_lei',
  'breaking_field', 'bnpp_value', 'cpty_value',
];

export function validateConfig(config) {
  for (const key of REQUIRED_COLUMNS) {
    if (!config.columns?.[key]) throw new Error(`Invalid configuration: missing mapping for column "${key}"`);
  }
  for (const [logical, physical] of Object.entries(config.columns)) {
    if (physical == null) continue; // optional mapping switched off (e.g. business_line: null)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(physical)) {
      throw new Error(`Invalid column name for "${logical}": ${physical}`);
    }
  }
}
