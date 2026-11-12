/*
 * The panel's sheets keep to the theme tokens (see the test-kit's theme-sheets). Every stylesheet under the panel's src/ is held:
 * the base and page sheets in css/ and each region's own.
 */
import { fileURLToPath } from 'node:url';
import { cssIn, themeTokenRules } from '@once-upon-a-diff/test-kit/theme-sheets';

themeTokenRules({
  tokens: fileURLToPath(import.meta.resolve('@once-upon-a-diff/ui-kit/css/tokens.css')),
  sheets: cssIn(fileURLToPath(new URL('../src/', import.meta.url))),
});
