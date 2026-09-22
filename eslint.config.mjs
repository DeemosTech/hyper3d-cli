import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';
import tsParser from '@typescript-eslint/parser';
import eslintConfigPrettier from 'eslint-config-prettier';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

import importPlugin from 'eslint-plugin-import';
import promise from 'eslint-plugin-promise';
import unusedImports from 'eslint-plugin-unused-imports';

/** @type {import('eslint').Linter.Config[]} */
export default [
  pluginJs.configs.recommended,
  ...tseslint.configs.strict,
  eslintConfigPrettier,
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/eslint.*'],
  },
  {
    files: ['packages/cli/src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: './packages/cli/tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      import: importPlugin,
      promise,
      'unused-imports': unusedImports,
    },

    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './packages/cli/tsconfig.json',
        },
        node: true,
      },
    },

    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-extraneous-class': 'off',

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', disallowTypeAnnotations: false },
      ],
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/restrict-plus-operands': [
        'error',
        { skipCompoundAssignments: true },
      ],
      '@typescript-eslint/method-signature-style': ['error', 'property'],

      'promise/always-return': 'error',
      'promise/no-multiple-resolved': 'error',
      'promise/no-nesting': 'warn',
      'promise/no-new-statics': 'error',
      'promise/no-return-in-finally': 'error',
      'promise/valid-params': 'error',
      '@typescript-eslint/promise-function-async': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],

      'import/first': 'error',
      'import/no-duplicates': 'error',
      'import/no-cycle': ['warn', { maxDepth: 3 }],
      'import/order': [
        'error',
        {
          groups: [
            'builtin',
            'external',
            'internal',
            'parent',
            'sibling',
            'index',
            'object',
            'type',
          ],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'unused-imports/no-unused-imports': 'error',

      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['test/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  eslintPluginPrettierRecommended,
];
