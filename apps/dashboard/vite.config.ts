import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the dashboard proxies the API to a running `memnest serve`, so it stays same-origin
// (the server has no CORS, and the session cookie is SameSite=Strict).
const server = process.env.MEMNEST_SERVER ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/v1': server, '/healthz': server } },
  worker: { format: 'es' },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
});
