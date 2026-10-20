#!/usr/bin/env node
// Desenvolvimento: API (node --watch, porta 3001) + Vite (http://localhost:5173, com proxy de /api para a API).
// Sem dependências extra (substitui o "concurrently"). Ctrl+C pára os dois.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { ROOT } from '../src/config.js';

const procs = [
  spawn(process.execPath, ['--watch-path=src', resolve(ROOT, 'scripts/serve.js')], { stdio: 'inherit', cwd: ROOT }),
  spawn(process.execPath, [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--config', 'web/vite.config.js'], { stdio: 'inherit', cwd: ROOT }),
];
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => { if (code) { stop(); process.exitCode = code; } }));
