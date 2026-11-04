import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@once-upon-a-diff/test-kit/dom';

const { document } = installDom({
  html: '<!doctype html><html><body><div id="app"></div></body></html>',
  rootId: 'app',
});
const { html } = await import('@once-upon-a-diff/protocol/domain/html');
const { insertHtml, setHtml, stylesheetLink } = await import('../src/dom.ts');

test('setHtml puts html`` markup in as is, and a plain string as text', () => {
  const box = document.createElement('div');
  setHtml(box, html`<b>${'a & b'}</b>`);
  assert.equal(box.innerHTML, '<b>a &amp; b</b>');
  setHtml(box, '<i>not markup</i>');
  assert.equal(box.textContent, '<i>not markup</i>');
  assert.equal(box.querySelector('i'), null);
});

test('insertHtml adds markup at a position the way setHtml reads it', () => {
  const box = document.createElement('div');
  setHtml(box, html`<p>one</p>`);
  insertHtml(box, 'beforeend', html`<p>${'<two>'}</p>`);
  assert.equal(box.innerHTML, '<p>one</p><p>&lt;two&gt;</p>');
});

test('stylesheetLink is a stylesheet link for the href', () => {
  const link = stylesheetLink('/assets/x.css');
  assert.equal(link.rel, 'stylesheet');
  assert.equal(link.getAttribute('href'), '/assets/x.css');
});
