import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so the built app can be served from any sub-path (artifact hosting).
export default defineConfig({
  plugins: [react()],
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 2000 },
  server: { port: 5173, host: '127.0.0.1' },
});
