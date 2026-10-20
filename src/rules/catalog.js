// Carrega e valida a configuração do motor de regras (config/rules/).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../config.js';
import { validateRules } from './compile.js';

export function loadFieldMap(path = resolve(ROOT, 'config/rules/field-map.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadRules({ fieldMap = loadFieldMap(), path = resolve(ROOT, 'config/rules/emir-vr.json') } = {}) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  validateRules(doc, fieldMap);
  return { fieldMap, rulesDoc: doc };
}

/** Todas as referências a itens usadas nas regras (when, compare.ref, count_populated.refs). */
export function referencedItems(rule) {
  const out = new Set();
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (x && typeof x === 'object') return Object.values(x).forEach(walk);
    if (typeof x === 'string' && /^\d+\.\d+$/.test(x)) out.add(x);
  };
  walk(rule.when);
  walk(rule.check);
  return [...out];
}
