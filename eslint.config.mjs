/*
 * ESLint 9 flat config with web-app's base presets (recommended,
 * import, promise, n for Node files, prettier) and typescript-eslint's
 * recommended rules, then this repo's own, stricter rules: braces on every
 * block, descriptive names, no nested ternaries, and full file extensions
 * (Node's type stripping and the bridge's local page resolve no bare paths).
 */
import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import importPlugin from 'eslint-plugin-import';
import nodePlugin from 'eslint-plugin-n';
import promisePlugin from 'eslint-plugin-promise';
import eslintPrettierConfig from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const NODE_FILES = [
  'packages/bridge/**/*.{ts,mjs}',
  'packages/*/scripts/**/*.{ts,mjs}',
  'packages/*/test/**/*.{ts,mjs}',
  'packages/*/*.config.{ts,mjs}',
  'skills/**/*.{ts,mjs}',
  '*.config.{ts,mjs}',
];
const LOCAL_PAGE = 'packages/bridge/public/**';

export default defineConfig(
  globalIgnores([
    '**/node_modules/',
    '**/.output/',
    '**/.wxt/',
    '.yarn/',
    'packages/bridge/public/vendor/',
  ]),
  eslint.configs.recommended,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  tseslint.configs.recommended,
  eslintPrettierConfig,
  {
    plugins: { promise: promisePlugin },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      ...promisePlugin.configs.recommended.rules,
      // web-app's offs
      'promise/catch-or-return': 'off',
      'promise/no-nesting': 'off',
      'promise/always-return': 'off',
      'import/no-unresolved': 'off',
      'no-useless-escape': 'off',
      // this repo's rules
      'consistent-return': 'off',
      curly: ['error', 'all'],
      'id-length': [
        'error',
        {
          min: 3,
          properties: 'never',
          exceptions: ['_', '$', 'e', 'i', 'j', 'k', 'id', 'ok', 'fs', 'os', 'el', 'pr'],
        },
      ],
      'import/extensions': ['error', 'always', { ignorePackages: true }],
      'max-len': ['warn', 250],
      'no-nested-ternary': 'error',
      'no-param-reassign': 'off',
      'no-sequences': 'error',
      'no-undef': 'error',
      'no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowShortCircuit: false, allowTernary: false },
      ],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
      radix: ['error', 'as-needed'],
    },
  },
  {
    // TypeScript checks names itself, and knows the types-only globals no-undef doesn't
    files: ['**/*.ts'],
    rules: { 'no-undef': 'off' },
  },
  {
    // the extension: browser and chrome.* globals
    files: ['packages/extension/src/**/*.{ts,js}'],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
  },
  {
    files: NODE_FILES,
    ignores: [LOCAL_PAGE],
    plugins: { n: nodePlugin },
    languageOptions: { globals: { ...globals.node } },
    rules: {
      ...nodePlugin.configs['flat/recommended'].rules,
      // web-app's offs
      'n/no-extraneous-import': 'off',
      'n/no-missing-import': 'off',
      'n/no-unsupported-features/node-builtins': 'off',
      'n/no-process-exit': 'off',
    },
  },
  {
    // the fake gh the tests point ONCE_UPON_GH at is run as a program, so it keeps its shebang
    files: ['packages/bridge/test/fixtures/*.{ts,mjs}'],
    rules: { 'n/hashbang': 'off' },
  },
);
