import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { tsconfigPaths: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4000', rewrite: (path) => path.replace(/^\/api/, '') } },
  },
  preview: { proxy: { '/api': { target: 'http://127.0.0.1:4000', rewrite: (path) => path.replace(/^\/api/, '') } } },
});
