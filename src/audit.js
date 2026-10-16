// Log de auditoria: cada pedido -> métrica -> SQL -> nº de linhas -> duração.
// Ficheiros JSONL diários em logs/. Sem linhas de dados, só metadados.
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './config.js';

export function audit(event, dir = resolve(ROOT, 'logs')) {
  try {
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(resolve(dir, `audit-${day}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  } catch (err) {
    // A auditoria nunca deve partir o pedido; mas avisamos.
    console.warn(`[audit] falhou a escrita do log: ${err.message}`);
  }
}
