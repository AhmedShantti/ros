// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'eslint.config.mjs',
      'prisma.config.ts',
      'src/generated/**',
      'dist/**',
      'coverage/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    // SRS §27.6 NFR-OBS-001 static regression gate (G1-3): runtime
    // application code must go through the structured logger
    // (`src/common/observability/logging/structured-logger.service.ts`),
    // never `console.*` directly, so a log line can never silently bypass
    // JSON structure/redaction. Scoped to `src/**` runtime code only — NOT
    // `test/**` or `*.spec.ts` (those are test diagnostics, not application
    // logs) and NOT `src/scripts/**` (standalone CLI tooling — seeding,
    // OpenAPI generation, signing — that runs outside any request context and
    // has always used `console.*`; a narrowly-scoped, justified exception,
    // not a loophole for request-path code).
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts', 'src/scripts/**'],
    rules: {
      'no-console': 'error',
    },
  },
);
