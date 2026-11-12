/*
 * The theme tokens stay the one alias layer: no sheet but ui-kit's tokens.css names a Primer variable (--fgColor-*, --bgColor-*,
 * --borderColor-*; GitHub's theme or the fallbacks supply them there), and every --ou-<token> a sheet reads is one tokens.css
 * defines. A package that owns sheets calls this once with its own sheets and the path to tokens.css (the test-kit sits under
 * ui-kit, so it cannot find the tokens itself); it registers the three rules as tests of that file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const read = (file: string) => readFileSync(file, 'utf8');

/** Every .css file under a directory, as absolute paths. */
export const cssIn = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.css'))
    .map((name) => path.join(dir, name));

const TOKEN_USE = /var\((--ou-(?:bg|fg|border|accent|ok|warn|danger|font)[\w-]*)/g;

/** Registers the three token rules over `sheets` (absolute paths); `tokens` is ui-kit's tokens.css. */
export function themeTokenRules({ tokens, sheets }: { tokens: string; sheets: string[] }): void {
  const tokenNames = new Set(
    [...read(tokens).matchAll(/^\s*(--ou-[\w-]+):/gm)].map((match) => match[1]),
  );

  test('no sheet but tokens.css names a Primer variable, or the old per-sheet aliases', () => {
    for (const sheet of sheets) {
      const text = read(sheet);
      assert.doesNotMatch(text, /--(fgColor|bgColor|borderColor)-/, sheet);
      assert.doesNotMatch(text, /--c-[a-z]|--ou-local-del-fg/, sheet);
    }
  });

  test('every theme token a sheet reads is defined in tokens.css', () => {
    assert.ok(tokenNames.has('--ou-danger'));
    for (const sheet of sheets) {
      for (const [, name] of read(sheet).matchAll(TOKEN_USE)) {
        assert.ok(tokenNames.has(name), `${sheet} reads ${name}`);
      }
    }
  });

  test('a color or font stack a sheet writes out is not a copy of a token', () => {
    for (const sheet of sheets) {
      assert.doesNotMatch(
        read(sheet),
        /BlinkMacSystemFont|ui-monospace/,
        `${sheet} has its own font stack`,
      );
    }
  });
}
