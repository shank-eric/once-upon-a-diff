import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@once-upon-a-diff/test-kit/dom';

const { document, window } = installDom({
  html: '<!doctype html><html><body><div id="app"></div></body></html>',
  rootId: 'app',
});
const { html } = await import('@once-upon-a-diff/domain/html');
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

const { mountShadow } = await import('../src/dom.ts');

test('mountShadow makes an open shadow root with the stylesheets, then the root element, and hides the host until they load', () => {
  const host = document.createElement('div');
  const { shadow, root, links } = mountShadow({
    host,
    stylesheets: ['/a.css', '/b.css'],
    className: 'n',
    role: 'status',
  });
  assert.equal(host.shadowRoot, shadow);
  assert.deepEqual(
    [...shadow.children].map((child) => child.tagName),
    ['LINK', 'LINK', 'DIV'],
  );
  assert.deepEqual(
    links.map((link) => link.getAttribute('href')),
    ['/a.css', '/b.css'],
  );
  assert.equal(shadow.lastElementChild, root);
  assert.equal(root.className, 'n');
  assert.equal(root.getAttribute('role'), 'status');
  assert.equal(host.parentNode, null, 'without `into` the caller places the host');
  assert.equal(host.style.visibility, 'hidden');
  for (const link of links) {
    link.dispatchEvent(new window.Event('load'));
  }
});

test('mountShadow takes the root’s tag, puts the host in `into`, and keeps key events in the root or the shadow as told', () => {
  /** Whether a key event sent to target is stopped there. */
  const stopped = (target: EventTarget) => {
    const event = new window.Event('keydown', { bubbles: true });
    let stops = 0;
    event.stopPropagation = () => void stops++;
    target.dispatchEvent(event);
    return stops > 0;
  };
  const rootHost = document.createElement('div');
  const inRoot = mountShadow({
    host: rootHost,
    stylesheets: ['/c.css'],
    className: 'slot',
    tag: 'span',
    isolateKeys: 'root',
    into: document.body,
  });
  assert.equal(inRoot.root.tagName, 'SPAN');
  assert.equal(rootHost.parentNode, document.body);
  assert.equal(inRoot.root.hasAttribute('role'), false);
  assert.equal(stopped(inRoot.root), true);
  assert.equal(stopped(inRoot.shadow), false, 'the root was asked, not the shadow');
  const shadowHost = document.createElement('div');
  const inShadow = mountShadow({
    host: shadowHost,
    stylesheets: [],
    className: 'x',
    isolateKeys: 'shadow',
  });
  assert.equal(stopped(inShadow.shadow), true);
  const plain = mountShadow({
    host: document.createElement('div'),
    stylesheets: [],
    className: 'y',
  });
  assert.equal(stopped(plain.root), false);
  assert.equal(stopped(plain.shadow), false);
  inRoot.links[0].dispatchEvent(new window.Event('load'));
});
