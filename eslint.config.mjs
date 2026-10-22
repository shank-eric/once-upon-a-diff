/*
 * ESLint 9 flat config with web-app's base presets (recommended,
 * import, promise, n for Node files, prettier), then this repo's own,
 * stricter rules: braces on every block, descriptive names, no nested
 * ternaries, and full file extensions (browser ESM without a bundler can't
 * resolve bare paths).
 */
import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import importPlugin from 'eslint-plugin-import';
import nodePlugin from 'eslint-plugin-n';
import promisePlugin from 'eslint-plugin-promise';
import eslintPrettierConfig from 'eslint-config-prettier';
import globals from 'globals';

const NODE_FILES = ['bridge/**/*.mjs', 'skills/**/*.mjs', 'scripts/**/*.mjs', 'test/**/*.mjs'];

export default defineConfig(
  globalIgnores(['node_modules/', 'build/', '.yarn/', 'bridge/public/vendor/']),
  eslint.configs.recommended,
  importPlugin.flatConfigs.recommended,
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
      'import/extensions': ['error', { js: 'always', mjs: 'always' }],
      'max-len': ['warn', 250],
      'no-nested-ternary': 'error',
      'no-param-reassign': 'off',
      'no-sequences': 'error',
      'no-undef': 'error',
      'no-unused-expressions': ['error', { allowShortCircuit: false, allowTernary: false }],
      'no-unused-vars': ['error', { ignoreRestSiblings: true }],
      quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
      radix: ['error', 'as-needed'],
    },
  },
  {
    // the extension: browser and chrome.* globals
    files: ['src/js/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
  },
  {
    files: NODE_FILES,
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
    files: ['test/fixtures/*.mjs'],
    rules: { 'n/hashbang': 'off' },
  },
);
