/*
 * The panel draws with Preact, so a part that writes into the DOM by hand is either a host node (the page's file blocks, the
 * document), a gesture that would otherwise redraw the panel at every pointer move, or something still to convert. This pins where
 * the hand writes are: a new one anywhere else fails, and converting one lowers its count here (the count says how many lines
 * use any of the ways below).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');
const BY_HAND =
  /\bsetHtml\(|\binsertHtml\(|\.innerHTML\b|insertAdjacentHTML|\.textContent\s*=[^=]|\.classList\.(add|remove|toggle)\(|\.hidden\s*=[^=]|\.disabled\s*=[^=]|\.on(click|input|submit)\s*=[^=]|\.(setAttribute|removeAttribute)\(|addEventListener\(/;

/** file (under src): [how many lines write by hand, why]. */
const ALLOWED: Record<string, [number, string]> = {
  'dom.ts': [
    7,
    'the helpers the extension and the local page use (setHtml, insertHtml, key isolation, waiting for styles)',
  ],
  'parse-markup.ts': [1, 'reads markup into a detached template'],
  'shell.ts': [
    11,
    'the frame: the host element and its stylesheets, the width grip and the root’s classes and listeners',
  ],
  'overlay.ts': [1, 'the window’s focus'],
  'ask/chat-dock.ts': [5, 'the dock’s height drag, written at each pointer move, and its resize'],
  'ask/questions.ts': [1, 'the tab showing again'],
  'reading/filter.ts': [12, 'the page’s file blocks (hidden marks) and its mutations'],
  'reading/navigation.ts': [1, 'the page’s scroll'],
  'reading/reading.ts': [2, 'the page’s visibility and unload'],
  'reading/scroll.ts': [4, 'the page’s scrolling and highlight'],
  'reading/viewed.ts': [2, 'the page’s Viewed toggles'],
  'start-listening.ts': [
    10,
    'wireStartListening, which the extension’s listen notice still uses (the panel has its own, with state)',
  ],
  'status-light-part.ts': [1, 'a prop set in a markup hook (the details box), not a node'],
  'body.ts': [1, 'the delegated click handler, for what the drafts and the fixes still write (2b)'],
  'copy-buttons.ts': [6, 'to convert with the drafts (2b)'],
  'drafts/drafts.ts': [35, 'to convert (2b)'],
  'fixes/fixes.ts': [4, 'to convert (2b)'],
  'fixes/working.ts': [3, 'the banner (2b) and the page’s dimmed blocks'],
  'rebuild/freshness.ts': [10, 'to convert (2b)'],
  'rebuild/rebuild.ts': [10, 'to convert (2b)'],
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return files(full);
    }
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

test('the panel writes into the DOM by hand only where it says it does', () => {
  const found: Record<string, number> = {};
  for (const file of files(SRC)) {
    const count = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .filter((line) => BY_HAND.test(line)).length;
    if (count) {
      found[path.relative(SRC, file)] = count;
    }
  }
  const pinned = Object.fromEntries(
    Object.entries(ALLOWED)
      .filter(([, [count]]) => count > 0)
      .map(([file, [count]]) => [file, count]),
  );
  assert.deepEqual(found, pinned);
});
