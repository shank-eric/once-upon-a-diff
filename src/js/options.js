import { getSettings, setSettings } from './shared/settings.js';

/** The page's elements by id; the form's fields are inputs. */
const $ = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

function status(text, ok) {
  $('status').textContent = text;
  $('status').className = ok ? 'ok' : 'bad';
}

/** The values in the form now, saved or not, so Test works before Save. */
const formSettings = () => ({ port: Number($('port').value), token: $('token').value.trim() });

async function test(prefix = '') {
  $('stories').textContent = '';
  const settings = formSettings();
  if (!settings.token) {
    return status(`${prefix}Paste the token from pr-story setup, then test.`, false);
  }
  const ask = (path) =>
    chrome.runtime.sendMessage({ type: 'bridge', method: 'GET', path, settings });
  const health = await ask('/api/health');
  if (!health.ok) {
    const why =
      {
        unreachable: 'nothing is listening on that port. Is pr-story serve running?',
        'not-configured': 'paste the token first.',
        'missing or wrong token':
          'the bridge rejected the token. Copy it again from pr-story setup.',
      }[health.error] || health.error;
    return status(`${prefix}Couldn't reach the bridge: ${why}`, false);
  }
  const list = await ask('/api/stories');
  const stories = (list.body && list.body.stories) || [];
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

async function init() {
  const settings = await getSettings();
  $('port').value = settings.port;
  $('token').value = settings.token;
  $('settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    await setSettings(formSettings());
    status('Saved. Testing…', true);
    test('Saved. ');
  });
  $('test').addEventListener('click', () => test());
}
init();
