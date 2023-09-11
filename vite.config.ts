import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solidPlugin()],
  server: {
    port: 59898,
    host: "localhost"
  },
  build: {
    sourcemap: true,
    target: 'esnext'
  },
  base: ''
});
