import { getSettings, setSettings } from '../../settings.ts';
import { isPageLink, type PageKind } from '../../page-links.ts';
import { bridgeProblem, createClient } from '@once-upon-a-diff/api-client/client';
import { ROUTES } from '@once-upon-a-diff/protocol/routes';
import type { BridgeRequest } from '../../content/bridge.ts';

/** The page's elements by id; the form's fields are inputs. */
const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

function status(text: string, ok: boolean) {
  $('status').textContent = text;
  $('status').className = ok ? 'ok' : 'bad';
}

/** The values in the form now, saved or not, so Test works before Save. */
const formSettings = () => ({ port: Number($('port').value), token: $('token').value.trim() });

/** The bridge client for the form's values (saved or not), through the service worker. */
const bridgeWith = (settings: ReturnType<typeof formSettings>) =>
  createClient((request) =>
    chrome.runtime.sendMessage({ type: 'bridge', ...request, settings } satisfies BridgeRequest),
  );

/** Counts one options-page action now (a rare click, so no batching), with the form's values. Names only. */
function count(name: 'ext.options.save' | 'ext.options.test' | 'ext.options.openBoard') {
  void bridgeWith(formSettings()).call(ROUTES.usageCount, { body: { counts: { [name]: 1 } } });
}

async function test(prefix = '') {
  $('stories').textContent = '';
  const settings = formSettings();
  if (!settings.token) {
    return status(`${prefix}Paste the token from once-upon setup, then test.`, false);
  }
  const bridge = bridgeWith(settings);
  const health = await bridge.call(ROUTES.health);
  if (!health.ok) {
    const why =
      bridgeProblem(health) === 'token'
        ? 'the bridge rejected the token. Copy it again from once-upon setup.'
        : (
            {
              unreachable: 'nothing is listening on that port. Is once-upon serve running?',
              'not-configured': 'paste the token first.',
            } as Record<string, string>
          )[health.error as string] || health.error;
    return status(`${prefix}Couldn't reach the bridge: ${why}`, false);
  }
  const list = await bridge.call(ROUTES.stories);
  // a failed list's body is the bridge's error, without stories
  const stories = (list.ok && list.body.stories) || [];
  status(
    `${prefix}Connected to the bridge ${health.body.version}. ${stories.length} stor${stories.length === 1 ? 'y' : 'ies'}:`,
    true,
  );
  for (const story of stories) {
    const item = document.createElement('li');
    item.textContent = `${story.title} (${story.kind === 'local' ? 'local commits' : `${story.repo}#${story.number}`})`;
    $('stories').appendChild(item);
  }
}

/**
 * Opens the bridge's board in a tab: the link, with its key, is the bridge's to make. `public=1` asks for
 * the proxy's address (https://once-upon.test) when that reaches this machine, so the page sets its cookie in this browser.
 */
async function openPage(kind: PageKind) {
  const settings = formSettings();
  const answer = await bridgeWith(settings).call(ROUTES.boardLink, { query: { public: '1' } });
  // only a link of the right shape is opened
  if (answer.ok && isPageLink(kind, answer.body.url)) {
    chrome.tabs.create({ url: answer.body.url });
  } else {
    status(`Couldn't open the ${kind}: ${answer.error || 'the bridge sent no link'}`, false);
  }
}

async function init() {
  const settings = await getSettings();
  $('port').value = String(settings.port);
  $('token').value = settings.token;
  $('settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    await setSettings(formSettings());
    count('ext.options.save');
    status('Saved. Testing…', true);
    test('Saved. ');
  });
  $('test').addEventListener('click', () => {
    count('ext.options.test');
    return test();
  });
  $('board').addEventListener('click', () => {
    count('ext.options.openBoard');
    return openPage('board');
  });
}
init();
