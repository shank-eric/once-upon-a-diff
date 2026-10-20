import { getSettings, setSettings } from './shared/settings.js';

const $ = id => document.getElementById(id);

function status(text, ok) {
  $('status').textContent = text;
  $('status').className = ok ? 'ok' : 'bad';
}

/** The values in the form now, saved or not, so Test works before Save. */
const formSettings = () => ({ port: Number($('port').value), token: $('token').value.trim() });

async function test(prefix = '') {
  $('stories').textContent = '';
  const settings = formSettings();
  if (!settings.token) return status(`${prefix}Paste the token from diff-story setup, then test.`, false);
  const ask = path => chrome.runtime.sendMessage({ type: 'bridge', method: 'GET', path, settings });
  const health = await ask('/api/health');
  if (!health.ok) {
    const why = {
      unreachable: 'nothing is listening on that port. Is diff-story serve running?',
      'not-configured': 'paste the token first.',
      'missing or wrong token': 'the bridge rejected the token. Copy it again from diff-story setup.',
    }[health.error] || health.error;
    return status(`${prefix}Couldn't reach the bridge: ${why}`, false);
  }
  const list = await ask('/api/stories');
  const stories = (list.body && list.body.stories) || [];
  status(`${prefix}Connected to the bridge ${health.body.version}. ${stories.length} stor${stories.length === 1 ? 'y' : 'ies'}:`, true);
  for (const s of stories) {
    const li = document.createElement('li');
    li.textContent = `${s.title} (${s.kind === 'local' ? 'local commits' : `${s.repo}#${s.number}`})`;
    $('stories').appendChild(li);
  }
}

async function init() {
  const s = await getSettings();
  $('port').value = s.port;
  $('token').value = s.token;
  $('settings').addEventListener('submit', async e => {
    e.preventDefault();
    await setSettings(formSettings());
    status('Saved. Testing…', true);
    test('Saved. ');
  });
  $('test').addEventListener('click', () => test());
}
init();
