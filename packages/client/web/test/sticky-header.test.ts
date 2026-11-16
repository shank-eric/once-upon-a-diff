import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// linkedom has no layout, so this reads the sheet text; the real layout is checked in the browser test (test:extension).
const diffCss = readFileSync(new URL('../public/local/diff/diff.css', import.meta.url), 'utf8');
const localCss = readFileSync(new URL('../public/local/local.css', import.meta.url), 'utf8');
const pageCss = readFileSync(new URL('../public/page.css', import.meta.url), 'utf8');

const ruleOf = (css: string, selector: string): string => {
  const found = [
    ...css.replace(/\/\*[^]*?\*\//g, '').matchAll(/(?:^|(?<=\}))\s*([^{}@]+)\{([^}]*)\}/g),
  ].find((match) => match[1]!.split(',').some((part) => part.trim() === selector));
  assert.ok(found, `no rule for ${selector}`);
  return found[2]!;
};
const prop = (body: string, name: string): string | undefined =>
  new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+)`).exec(body)?.[1]?.trim();

test('a local file header is pinned under the top bar', () => {
  const head = ruleOf(diffCss, '.ou-local-file-head');
  assert.equal(prop(head, 'position'), 'sticky');
  assert.ok(prop(head, 'top'), 'sticky needs a top');
  const top = ruleOf(pageCss, '.ou-local-top');
  assert.ok(Number(prop(head, 'z-index')) < Number(prop(top, 'z-index')), 'under the top bar');
});

test('nothing above the file header makes a scroll container', () => {
  const sheet = `${diffCss}\n${localCss}`;
  for (const selector of [
    '.ou-local-file',
    '.ou-local-file-wrap',
    '.ou-local-files',
    '.ou-local-layout',
  ]) {
    const overflow = prop(ruleOf(sheet, selector), 'overflow');
    assert.ok(
      overflow === undefined || overflow === 'visible' || overflow === 'clip',
      `${selector} overflow: ${overflow}`,
    );
  }
});

test('the file header and the scroll offset share the top bar height', () => {
  const actions = readFileSync(new URL('../public/local/actions.ts', import.meta.url), 'utf8');
  const TOP_BAR = /export const TOP_BAR = (\d+);/.exec(actions)?.[1];
  assert.ok(TOP_BAR, 'actions.ts exports TOP_BAR');
  assert.equal(prop(ruleOf(diffCss, '.ou-local-file-head'), 'top'), `${TOP_BAR}px`);
  assert.equal(prop(ruleOf(diffCss, '.ou-local-tree'), 'top'), `${TOP_BAR}px`);
});
