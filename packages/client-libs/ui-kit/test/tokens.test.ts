import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/css/tokens.css', import.meta.url), 'utf8');
const declarations = [...css.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((match) => ({
  name: match[1],
  value: match[2].trim(),
}));

test('tokens.css declares only --ou-* names, and never a Primer name (GitHub supplies those)', () => {
  assert.ok(declarations.length > 20);
  for (const { name } of declarations) {
    assert.match(name, /^--ou-/, `${name} is ours`);
  }
});

test('every colour token is var(<Primer name>, <fallback>), light or dark', () => {
  const fonts = declarations.filter((decl) => decl.name.startsWith('--ou-font-'));
  assert.deepEqual(fonts.map((decl) => decl.name).sort(), ['--ou-font-mono', '--ou-font-sans']);
  for (const { name, value } of declarations.filter(
    (decl) => !decl.name.startsWith('--ou-font-'),
  )) {
    assert.match(
      value,
      /^var\(--(fgColor|bgColor|borderColor)-[A-Za-z-]+, #[0-9a-f]{3,8}\)$/,
      name,
    );
  }
});

test('a dark fallback only restates a token the light block has', () => {
  const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
  const light = css.slice(0, css.indexOf('@media (prefers-color-scheme: dark)'));
  for (const [, name] of dark.matchAll(/^\s*(--ou-[\w-]+):/gm)) {
    assert.ok(light.includes(`${name}:`), `${name} has a light value`);
  }
});
