/*
 * The status light in the toolbar: is the bridge there, is there a story,
 * and is a Claude session listening for questions (opts.status, on the
 * overlay's tick every 30s, and when the tab gets focus again).
 * Clicking it shows the checks. When no session is listening, a hint over the
 * Ask box gives the prompt to paste into Claude Code.
 *
 * healthChecks has no DOM, so node tests can use it.
 */
import { escapeHtml } from '../util/html.js';
import { copyPrompt } from './copy-buttons.js';

const bridgeProblem = (code) => {
  if (code === 'token') {
    return [
      'The bridge rejected the token',
      'Copy it again from pr-story setup into the extension options',
    ];
  }
  if (code === 'old') {
    return ['The bridge is older than this panel', 'Restart it: pr-story serve'];
  }
  return ["The bridge isn't reachable", 'Start it: pr-story serve'];
};

/** {level: 'ok'|'warn'|'error', checks, listening, prompt, details, repo, checkout} from opts.status()'s answer, or its error. */
export function healthChecks(health, err) {
  if (err) {
    const [detail, fix] = bridgeProblem(err.code);
    return { level: 'error', checks: [{ ok: false, bad: true, name: 'Bridge', detail, fix }] };
  }
  const checks = [
    { ok: true, name: 'Bridge', detail: `reachable, token accepted (${health.bridge.version})` },
  ];
  if (health.story) {
    checks.push({
      ok: health.story.ok,
      name: 'Story',
      detail: health.story.ok ? `found (${health.story.id})` : 'not found for this page',
    });
  }
  const listening = health.listening || {};
  if (listening.ok) {
    checks.push({
      ok: true,
      name: 'Claude listening',
      detail: (listening.consumers || [])
        .map(
          (consumer) =>
            `${consumer.consumer}${consumer.state === 'handling' ? ', answering a question' : ''}`,
        )
        .join(', '),
    });
  } else {
    checks.push({
      ok: false,
      name: 'Claude listening',
      detail: 'no Claude session is listening; questions will wait in the inbox',
      fix: listening.start || 'pr-story wait --consumer pr-story',
    });
  }
  return {
    level: !listening.ok || (health.story && !health.story.ok) ? 'warn' : 'ok',
    checks,
    listening: listening.ok,
    prompt: listening.prompt || null,
    details: listening.details || null,
    repo: listening.repo || null,
    checkout: listening.checkout || null,
  };
}

const markOf = (check) => {
  if (check.ok) {
    return '✓';
  }
  return check.bad ? '✗' : '!';
};
const classOf = (check) => {
  if (check.ok) {
    return 'prs-hok';
  }
  return check.bad ? 'prs-herr' : 'prs-hwarn';
};

/** What the hint over the Ask box says when no session will answer. */
function askHintHtml(result) {
  if (result.level === 'error') {
    return `${escapeHtml(result.checks[0].detail)}. Questions can't be sent until it's back.`;
  }
  if (!result.prompt) {
    return 'No Claude session is listening; questions will wait. Start one in Claude Code as a background task: <code>pr-story wait --consumer pr-story</code>';
  }
  const where = result.checkout
    ? `Start Claude Code in <code>${escapeHtml(result.checkout)}</code> and paste`
    : 'Paste into Claude Code';
  return (
    `No Claude session is listening${result.repo ? ` for ${escapeHtml(result.repo)}` : ''}; questions will wait. ` +
    `${where} <code>${escapeHtml(result.prompt)}</code> ` +
    '<button type="button" class="prs-copyprompt">Copy prompt for Claude</button>' +
    (result.details
      ? ' <button type="button" class="prs-promptmore" aria-expanded="false">show details</button>'
      : '') +
    `<pre class="prs-prompt" hidden></pre>${result.details ? `<pre class="prs-promptlong" hidden>Without the pr-story-listen skill, paste this instead:\n${escapeHtml(result.details)}</pre>` : ''}`
  );
}

export function createStatusLight(context) {
  const { opts, shell } = context;
  const { $ } = shell;
  let health = null;

  function render(result) {
    const light = $('.prs-light');
    light.setAttribute('data-level', result.level);
    light.title =
      result.checks.map((check) => `${markOf(check)} ${check.name}: ${check.detail}`).join('\n') +
      '\n(click for details)';
    const rows = result.checks.map((check) => {
      const fix = check.fix
        ? `<br><span class="prs-why">${escapeHtml(check.fix.replace(/^In a Claude Code session, run as a background task: /, 'In Claude Code, run as a background task: '))}</span>`
        : '';
      return `<li><span class="${classOf(check)}">${markOf(check)}</span> <b>${escapeHtml(check.name)}</b>: ${escapeHtml(check.detail)}${fix}</li>`;
    });
    $('.prs-health').innerHTML = `<ul>${rows.join('')}</ul>`;
    const hint = $('.prs-askhint');
    const showHint = opts.ask && result.level !== 'ok' && !result.listening;
    hint.hidden = !showHint;
    if (!showHint) {
      return;
    }
    const html = askHintHtml(result);
    // redrawn on every refresh, so only when it changes (a "Copied" label stays put)
    if (hint.getAttribute('data-html') === html) {
      return;
    }
    hint.setAttribute('data-html', html);
    hint.innerHTML = html;
    const copyButton = hint.querySelector('.prs-copyprompt');
    if (copyButton) {
      copyButton.onclick = () =>
        copyPrompt(result.prompt, copyButton, hint.querySelector('.prs-prompt'));
    }
    const more = hint.querySelector('.prs-promptmore');
    if (more) {
      more.onclick = () => {
        const long = hint.querySelector('.prs-promptlong');
        long.hidden = !long.hidden;
        more.setAttribute('aria-expanded', String(!long.hidden));
        more.textContent = long.hidden ? 'show details' : 'hide details';
      };
    }
  }

  async function refresh() {
    if (!opts.status) {
      return;
    }
    try {
      health = healthChecks(await opts.status());
    } catch (err) {
      health = healthChecks(null, err || {});
    }
    render(health);
  }

  $('.prs-light').addEventListener('click', () => {
    const box = $('.prs-health');
    box.hidden = !box.hidden;
    $('.prs-light').setAttribute('aria-expanded', String(!box.hidden));
  });
  if (opts.status) {
    refresh();
  } else {
    $('.prs-light').hidden = true;
  }

  return {
    get current() {
      return health;
    },
    refresh,
  };
}
