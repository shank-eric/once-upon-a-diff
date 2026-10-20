import { getSettings, setSettings } from './shared/settings.js';

const $ = id => document.getElementById(id);

function status(text, ok) {
  $('status').textContent = text;
  $('status').className = ok ? 'ok' : 'bad';
}

async function test() {
  $('stories').textContent = '';
  const health = await chrome.runtime.sendMessage({ type: 'bridge', method: 'GET', path: '/api/health' });
  if (!health.ok) {
    const why = { unreachable: 'nothing is listening on that port. Is diff-story serve running?', 'not-configured': 'set the token first.' }[health.error] || health.error;
    return status(`Couldn't reach the bridge: ${why}`, false);
  }
  const list = await chrome.runtime.sendMessage({ type: 'bridge', method: 'GET', path: '/api/stories' });
  const stories = (list.body && list.body.stories) || [];
  status(`Connected to the bridge ${health.body.version}. ${stories.length} stor${stories.length === 1 ? 'y' : 'ies'}:`, true);
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
    await setSettings({ port: Number($('port').value), token: $('token').value.trim() });
    status('Saved.', true);
    test();
  });
  $('test').addEventListener('click', test);
}
init();
