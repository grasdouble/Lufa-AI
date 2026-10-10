import { defineConfig } from 'astro/config';

export default defineConfig({
  base: process.env.ASTRO_BASE ?? '/',
  outDir: process.env.ASTRO_OUT_DIR ?? './dist',
  output: 'static',
});
