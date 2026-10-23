// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * The status light in the toolbar: is the bridge there, is there a story,
 * and is a Claude session listening for questions (opts.status, on the
 * overlay's tick every 30s, and when the tab gets focus again).
 * Clicking it shows the checks. When no session is listening, a hint over the
 * Ask box gives the prompt to paste into Claude Code. A line under it says
 * which session answers this story, with "Copy prompt for this story" to send
 * the story's questions to one session (the one that built it) instead.
 *
 * healthChecks has no DOM, so node tests can use it.
 */
import { html } from '../util/html.ts';
import { setHtml } from '../util/dom.ts';
import { copyPrompt } from './copy-buttons.ts';

const bridgeProblem = (code) => {
  if (code === 'token') {
    return [
      'The bridge rejected the token',
      'Copy it again from once-upon setup into the extension options',
    ];
  }
  if (code === 'old') {
    return ['The bridge is older than this panel', 'Restart it: once-upon serve'];
  }
  return ["The bridge isn't reachable", 'Start it: once-upon serve'];
};

/** What a listener covers, after its name. */
const coverOf = (consumer) => {
  if (consumer.story) {
    return ' (this story)';
  }
  return consumer.repo ? ' (whole repo)' : '';
};

/**
 * {level: 'ok'|'warn'|'error', checks, listening, prompt, details, repo, checkout, answering, storyPrompt} from
 * opts.status()'s answer, or its error.
 */
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
            `${consumer.consumer}${coverOf(consumer)}${consumer.state === 'handling' ? ', answering a question' : ''}`,
        )
        .join(', '),
    });
  } else {
    checks.push({
      ok: false,
      name: 'Claude listening',
      detail: 'no Claude session is listening; questions will wait in the inbox',
      fix: listening.start || 'once-upon wait --consumer once-upon',
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
    answering: listening.answering || null,
    storyPrompt: listening.story_prompt || null,
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
    return 'ou-hok';
  }
  return check.bad ? 'ou-herr' : 'ou-hwarn';
};

/** What the hint over the Ask box says when no session will answer. */
function askHintHtml(result) {
  if (result.level === 'error') {
    return html`${result.checks[0].detail}. Questions can't be sent until it's back.`;
  }
  if (!result.prompt) {
    return html`No Claude session is listening; questions will wait. Start one in Claude Code as a background task: <code>once-upon wait --consumer once-upon</code>`;
  }
  const where = result.checkout
    ? html`Start Claude Code in <code>${result.checkout}</code> and paste`
    : 'Paste into Claude Code';
  const forRepo = result.repo && ` for ${result.repo}`;
  const more =
    result.details &&
    html` <button type="button" class="ou-promptmore" aria-expanded="false">show details</button>`;
  const long =
    result.details &&
    html`<pre class="ou-promptlong" hidden>Without the once-upon-listen skill, paste this instead:\n${result.details}</pre>`;
  return html`No Claude session is listening${forRepo}; questions will wait. ${where} <code>${result.prompt}</code> <button type="button" class="ou-copyprompt">Copy prompt for Claude</button>${more}<pre class="ou-prompt" hidden></pre>${long}`;
}

/** The line under the Ask box: who answers this story's questions, and the prompt that gives them to one session. */
export function askWhoHtml(result) {
  if (result.level === 'error') {
    return html``;
  }
  const { answering, storyPrompt } = result;
  let copy = null;
  if (storyPrompt && storyPrompt.prompt !== result.prompt) {
    const title =
      `Copies ${storyPrompt.prompt}. Paste it into the Claude session that built this story: ` +
      "it answers this story's questions from then on, ahead of the repo's listener.";
    copy = html` <button type="button" class="ou-copystory" title="${title}">Copy prompt for this story</button><pre class="ou-prompt" hidden></pre>`;
  }
  if (answering && answering.scope === 'story') {
    return html`Answered by <b>${answering.consumer}</b>, the session listening for this story.`;
  }
  if (answering) {
    const cover =
      answering.scope === 'repo' ? 'listening for the whole repo' : 'listening for everything';
    return html`Answered by <b>${answering.consumer}</b> (${cover}).${copy}`;
  }
  return copy ? html`Or have one session answer just this story:${copy}` : html``;
}

export function createStatusLight(context) {
  const { opts, shell } = context;
  const { $ } = shell;
  let health = null;

  function render(result) {
    const light = $('.ou-light');
    light.setAttribute('data-level', result.level);
    light.title =
      result.checks.map((check) => `${markOf(check)} ${check.name}: ${check.detail}`).join('\n') +
      '\n(click for details)';
    const rows = result.checks.map((check) => {
      const fixText =
        check.fix &&
        check.fix.replace(
          /^In a Claude Code session, run as a background task: /,
          'In Claude Code, run as a background task: ',
        );
      const fix = fixText && html`<br><span class="ou-why">${fixText}</span>`;
      return html`<li><span class="${classOf(check)}">${markOf(check)}</span> <b>${check.name}</b>: ${check.detail}${fix}</li>`;
    });
    setHtml($('.ou-health'), html`<ul>${rows}</ul>`);
    renderWho(result);
    const hint = $('.ou-askhint');
    const showHint = opts.ask && result.level !== 'ok' && !result.listening;
    hint.hidden = !showHint;
    if (!showHint) {
      return;
    }
    const hintHtml = askHintHtml(result);
    const markup = String(hintHtml);
    // redrawn on every refresh, so only when it changes (a "Copied" label stays put)
    if (hint.getAttribute('data-html') === markup) {
      return;
    }
    hint.setAttribute('data-html', markup);
    setHtml(hint, hintHtml);
    const copyButton = hint.querySelector('.ou-copyprompt');
    if (copyButton) {
      copyButton.onclick = () =>
        copyPrompt(result.prompt, copyButton, hint.querySelector('.ou-prompt'));
    }
    const more = hint.querySelector('.ou-promptmore');
    if (more) {
      more.onclick = () => {
        const long = hint.querySelector('.ou-promptlong');
        long.hidden = !long.hidden;
        more.setAttribute('aria-expanded', String(!long.hidden));
        more.textContent = long.hidden ? 'show details' : 'hide details';
      };
    }
  }

  function renderWho(result) {
    const who = $('.ou-askwho');
    const whoHtml = opts.ask ? askWhoHtml(result) : html``;
    const markup = String(whoHtml);
    who.hidden = !markup;
    // redrawn only when it changes, so a "Copied" label stays put
    if (who.getAttribute('data-html') === markup) {
      return;
    }
    who.setAttribute('data-html', markup);
    setHtml(who, whoHtml);
    const copyButton = who.querySelector('.ou-copystory');
    if (copyButton) {
      copyButton.onclick = () =>
        copyPrompt(result.storyPrompt.prompt, copyButton, who.querySelector('.ou-prompt'));
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

  $('.ou-light').addEventListener('click', () => {
    const box = $('.ou-health');
    box.hidden = !box.hidden;
    $('.ou-light').setAttribute('aria-expanded', String(!box.hidden));
  });
  if (opts.status) {
    refresh();
  } else {
    $('.ou-light').hidden = true;
  }

  return {
    get current() {
      return health;
    },
    refresh,
  };
}
