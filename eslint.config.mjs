// @ts-check
// Flat configuration with the IntellegenceLayer rule set (packages/config/.eslintrc.json): eslint and
// typescript-eslint recommended, unused variables an error unless prefixed with an underscore, explicit any,
// non-null assertions and console use as warnings, and the same relaxations for tests. IL's workspace import
// restriction does not apply to this single-package service.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'vendor/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      'no-console': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.test.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
