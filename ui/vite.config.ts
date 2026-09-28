import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode, command }) => {
  if (command === 'build') return { plugins: [react()] };
  // Shared backend .env is read server-side only; no secrets are injected into the bundle.
  const env = loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), '');
  const target = env.API_PROXY_TARGET || `http://127.0.0.1:${env.PORT || 4300}`;
  const app = new URL(env.APP_PUBLIC_URL);
  return {
    plugins: [react()],
    server: {
      host: app.hostname,
      port: Number(app.port || (app.protocol === 'https:' ? 443 : 80)),
      strictPort: true,
      proxy: { '/api': { target, changeOrigin: false, rewrite: path => path.replace(/^\/api/, '') } },
    },
  };
});
