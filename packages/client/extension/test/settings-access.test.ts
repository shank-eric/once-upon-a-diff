import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockStorage } from '../src/settings.ts';
import { storeCall, isStoreKey, REFRESH_KEY } from '../src/store-call.ts';
import { loadPanelUi, savePanelUi, loadPrefsCopy, storePrefsCopy } from '../src/content/storage.ts';

/** A chrome whose storage.local is the token's area, closed to content scripts, and a worker that answers `store` messages from it. */
function installChrome() {
  const area: Record<string, unknown> = { settings: { port: 1, token: 'secret-token' } };
  const levels: string[] = [];
  const direct: string[] = []; // what a content script touched in chrome.storage.local itself
  const storage = {
    get: async (key: string) => ({ [key]: area[key] }),
    set: async (items: Record<string, unknown>) => {
      Object.assign(area, items);
    },
  };
  Object.assign(globalThis, {
    chrome: {
      runtime: {
        id: 'ext',
        sendMessage: (message: { type: string; key: string }) =>
          storeCall(message as never, storage),
      },
      storage: {
        local: {
          setAccessLevel: async ({ accessLevel }: { accessLevel: string }) =>
            void levels.push(accessLevel),
          get: () => {
            direct.push('get');
            throw new Error('not allowed for a content script');
          },
          set: () => {
            direct.push('set');
            throw new Error('not allowed for a content script');
          },
        },
      },
    },
  });
  return { area, levels, direct };
}

test('the worker closes chrome.storage.local to content scripts, and a browser without it carries on', async () => {
  const { levels } = installChrome();
  await lockStorage();
  assert.deepEqual(levels, ['TRUSTED_CONTEXTS']);
  delete (globalThis as { chrome?: unknown }).chrome;
  Object.assign(globalThis, { chrome: { storage: { local: {} } } });
  await lockStorage(); // no setAccessLevel: no throw
});

test('a content script keeps its state through the worker and never touches chrome.storage.local', async () => {
  const { area, direct } = installChrome();
  await savePanelUi('acme/widgets/7', { n: 2 } as never);
  assert.deepEqual(area['ui:acme/widgets/7'], { n: 2 });
  assert.deepEqual(await loadPanelUi('acme/widgets/7'), { n: 2 });
  await storePrefsCopy({ hideWhitespace: true });
  assert.deepEqual(await loadPrefsCopy(), { hideWhitespace: true });
  assert.deepEqual(direct, []);
});

test('the token is not readable through a store message', async () => {
  const { area } = installChrome();
  const storage = {
    get: async (key: string) => ({ [key]: area[key] }),
    set: async () => undefined,
  };
  assert.deepEqual(await storeCall({ type: 'store', op: 'get', key: 'settings' }, storage), {
    ok: false,
  });
  assert.deepEqual(
    await storeCall({ type: 'store', op: 'set', key: 'settings', value: {} }, storage),
    { ok: false },
  );
  assert.deepEqual(await storeCall({ type: 'store', op: 'get', key: 'ui:x' }, storage), {
    ok: true,
    value: undefined,
  });
  assert.deepEqual(['ui:x', 'prefs', REFRESH_KEY].map(isStoreKey), [true, true, true]);
  assert.deepEqual(['settings', 'ui:', '', 7, null].map(isStoreKey), [
    false,
    false,
    false,
    false,
    false,
  ]);
  assert.equal((area.settings as { token: string }).token, 'secret-token');
});
