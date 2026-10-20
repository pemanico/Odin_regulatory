// Carrega a configuração: config/default.json + config/local.json (opcional) + .env + variáveis de ambiente.
// Nomes de tabelas, colunas e caminhos vivem aqui, nunca hardcoded no resto do código.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeExcludedDates } from './semantic/calendar.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Lê um ficheiro .env simples (KEY=VALUE). Não sobrepõe variáveis já definidas. */
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

/** Devolve a configuração final. `overrides` serve para testes. */
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
      ...(env.ODIN_BUSINESS_DATE_FORMAT ? { businessDateFormat: env.ODIN_BUSINESS_DATE_FORMAT } : {}),
    },
  });
  if (env.ODIN_EXCLUDED_DATES !== undefined) {
    // Lista separada por vírgulas; vazio = nenhuma data excluída (ex.: dados sintéticos).
    config.excludedDates = env.ODIN_EXCLUDED_DATES.split(',').map((s) => s.trim()).filter(Boolean);
  }
  config = deepMerge(config, overrides);
  // Compatibilidade: `uti_alt` (antes de 2026-10-20) passou a chamar-se `proprietary`.
  if (config.columns?.uti_alt !== undefined) {
    if (config.columns.uti_alt) config.columns.proprietary = config.columns.uti_alt;
    delete config.columns.uti_alt;
  }
  config.excludedDates = normalizeExcludedDates(config.excludedDates);

  config.source.breaksGlob = absolute(config.source.breaksGlob);
  config.source.dbPath = absolute(config.source.dbPath);
  validateConfig(config);
  return config;
}

const REQUIRED_COLUMNS = [
  'rec_stat_id', 'business_date', 'report_submitting_entity', 'uti', 'proprietary', 'cp1_lei', 'cp2_lei',
  'breaking_field', 'bnpp_value', 'cpty_value',
];

export function validateConfig(config) {
  for (const key of REQUIRED_COLUMNS) {
    if (!config.columns?.[key]) throw new Error(`Configuração inválida: falta o mapeamento da coluna "${key}"`);
  }
  for (const [logical, physical] of Object.entries(config.columns)) {
    if (physical == null) continue; // mapeamento opcional desligado (ex.: business_line: null)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(physical)) {
      throw new Error(`Nome de coluna inválido para "${logical}": ${physical}`);
    }
  }
}
