import js from '@eslint/js';
import ts from 'typescript-eslint';

export default ts.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.next-local/**', '.tagent/**', 'output/**', 'references/**'] },
  {
    files: ['packages/tagent-ai/src/**/*.ts', 'packages/tagent-core/src/**/*.ts', 'packages/tagent-server/src/**/*.ts'],
    extends: [js.configs.recommended, ...ts.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
);
