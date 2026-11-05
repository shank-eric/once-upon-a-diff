import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeClipboard } from '../src/clipboard.ts';

/** Runs `body` with navigator.clipboard replaced (or removed), then puts it back. */
async function withClipboard(clipboard: unknown, body: () => Promise<void>) {
  const before = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: clipboard,
  });
  try {
    await body();
  } finally {
    if (before) {
      Object.defineProperty(globalThis.navigator, 'clipboard', before);
    } else {
      delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
    }
  }
}

test('writeClipboard says true once the text is on the clipboard', async () => {
  const written: string[] = [];
  await withClipboard({ writeText: async (text: string) => void written.push(text) }, async () => {
    assert.equal(await writeClipboard('notes.md'), true);
  });
  assert.deepEqual(written, ['notes.md']);
});

test('writeClipboard says false, and never rejects, when the page has no clipboard or it refuses', async () => {
  await withClipboard(undefined, async () => {
    assert.equal(await writeClipboard('x'), false);
  });
  await withClipboard({}, async () => {
    assert.equal(await writeClipboard('x'), false);
  });
  await withClipboard(
    {
      writeText: async () => {
        throw new Error('not allowed');
      },
    },
    async () => {
      assert.equal(await writeClipboard('x'), false);
    },
  );
});
