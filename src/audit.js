// Audit log: each request -> metric -> SQL -> row count -> duration.
// Daily JSONL files in logs/. No data rows, metadata only.
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './config.js';

export function audit(event, dir = resolve(ROOT, 'logs')) {
  try {
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(resolve(dir, `audit-${day}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  } catch (err) {
    // Auditing must never break the request; but we warn.
    console.warn(`[audit] failed to write the log: ${err.message}`);
  }
}
