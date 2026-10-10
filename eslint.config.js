import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'web/.astro/**',
      'tests/fixtures/web-security/.astro/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['web/src/scripts/**/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    languageOptions: {
      globals: globals.node,
    },
  },
);
