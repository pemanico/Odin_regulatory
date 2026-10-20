// Frontend da demo (Vite + React). `npm run dev` (com a API) ou `npm run build` -> web/dist (servido por `npm start`).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': `http://127.0.0.1:${process.env.ODIN_PORT || 3001}` },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
