/*
 * The content script's own elements are Preact: a component draws from data, with no markup string and no innerHTML. This pins
 * that for all of content/ (no setHtml, insertHtml, innerHTML, outerHTML, insertAdjacent* or the protocol's html`` markup), and
 * pins where content/components still writes into the DOM by hand: a host node on GitHub's page, its shadow root and its
 * stylesheet, which a component cannot be (GitHub's page is a host we do not control, so each element gets its own shadow root
 * made here). A new write anywhere else in components fails, and a file's count can only fall. The write pattern and its probes
 * are the panel's (the test kit's dom-writes.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { code, files, writesIn } from '@once-upon-a-diff/test-kit/dom-writes';

const CONTENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/content');
const COMPONENTS = path.join(CONTENT, 'components');

/** file (under content/components): [how many hand writes, why]. A count can only fall. */
const ALLOWED: Record<string, [number, string]> = {
  'tag-host.ts': [
    6,
    'the tag’s host span on GitHub’s page: its attribute, shadow root and stylesheet, and the click listener on the shadow root',
  ],
  'listen-notice.ts': [
    9,
    'the notice’s host div, its shadow root and stylesheet, the box Preact draws into, and the hide click and key isolation on it',
  ],
  'toast.ts': [
    8,
    'the toast’s host div on GitHub’s page, its shadow root, stylesheet and message, and its removal',
  ],
};

const MARKUP = new RegExp(
  [
    String.raw`\bsetHtml\b`,
    String.raw`\binsertHtml\b`,
    String.raw`\.(innerHTML|outerHTML)\b`,
    String.raw`\.insertAdjacentHTML\b`,
    String.raw`protocol/domain/html`,
    String.raw`\.markup\b`,
  ].join('|'),
);

test('no file under content/ builds markup from a string', () => {
  // (components draw with the vendored Preact's html``, which builds elements; the markup string is the protocol's html``)
  for (const file of files(CONTENT)) {
    const found = code(readFileSync(file, 'utf8')).match(MARKUP);
    assert.equal(found && found[0], null, `${path.relative(CONTENT, file)} builds markup`);
  }
});

test('components write into the DOM by hand only where it says it does', () => {
  const found: Record<string, number> = {};
  for (const file of files(COMPONENTS)) {
    const count = writesIn(readFileSync(file, 'utf8'));
    if (count) {
      found[path.relative(COMPONENTS, file)] = count;
    }
  }
  const pinned = Object.fromEntries(
    Object.entries(ALLOWED)
      .filter(([, [count]]) => count > 0)
      .map(([file, [count]]) => [file, count]),
  );
  assert.deepEqual(found, pinned);
});

test('every way of building markup from a string is matched, and Preact’s html`` is not', () => {
  const strings = [
    'setHtml(slot, markup)',
    'insertHtml(el, "beforeend", markup)',
    'el.innerHTML = x',
    'const x = el.outerHTML',
    'el.insertAdjacentHTML("beforeend", x)',
    "import { html } from '@once-upon-a-diff/protocol/domain/html';",
    'String(markup) === html`<b></b>`.markup',
  ];
  for (const line of strings) {
    assert.match(line, MARKUP, `${line} is markup`);
  }
  assert.doesNotMatch(
    "import { html } from '/assets/preact.mjs'; html`<b>${x}</b>`",
    MARKUP,
    'Preact’s html builds elements',
  );
});
