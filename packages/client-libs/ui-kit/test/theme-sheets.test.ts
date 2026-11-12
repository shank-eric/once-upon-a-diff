/*
 * ui-kit's own stylesheet keeps to the theme tokens (see the test-kit's theme-sheets): ui.css names no Primer variable and reads
 * only tokens that tokens.css defines.
 */
import { fileURLToPath } from 'node:url';
import { themeTokenRules } from '@once-upon-a-diff/test-kit/theme-sheets';

themeTokenRules({
  tokens: fileURLToPath(new URL('../src/css/tokens.css', import.meta.url)),
  sheets: [fileURLToPath(new URL('../src/css/ui.css', import.meta.url))],
});
