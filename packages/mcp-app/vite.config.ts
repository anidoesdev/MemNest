import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// MCP hosts load an app from one HTML resource in a sandboxed iframe, so scripts and styles are inlined.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { outDir: 'dist', target: 'es2022', sourcemap: false },
});
