/*
 * The status light in the toolbar: is the bridge there, is there a story,
 * and is a Claude session listening for questions (opts.status, on the
 * overlay's tick every 30s, and when the tab gets focus again).
 * Clicking it shows the checks. When no session is listening, a hint over the
 * Ask box has Start listening, which types the listen line into an idle Claude Code session in the repo. A line under it
 * says which session answers this story, with "Start listening for this story" to send the story's questions to one
 * session (the one that built it) instead. Both go through the bridge (opts.listen); the line is shown too, for a
 * session that can't be typed into.
 *
 * This file has no DOM and no Preact, so node tests can use it (healthChecks, askHintHtml, askWhoHtml). The light, the checks and
 * the buttons are drawn by status-light-part.ts.
 */
import { html } from '@once-upon-a-diff/terms/html';
import type {
  Answering,
  BridgeStatus,
  ListenerView,
  Listening,
  StatusError,
} from '@once-upon-a-diff/contracts/types';

/** One line of the status light's checks: ok, a warning, or (bad) an error, and how to fix it. */
export interface HealthCheck {
  ok: boolean;
  bad?: boolean;
  name: string;
  detail: string;
  fix?: string;
}

/** What the status light shows, from opts.status(). */
export interface Health {
  level: 'ok' | 'warn' | 'error';
  checks: HealthCheck[];
  listening?: boolean;
  prompt?: string | null;
  details?: string | null;
  repo?: string | null;
  checkout?: string | null;
  answering?: Answering | null;
  agent?: string | null;
  storyPrompt?: { prompt: string } | null;
}

const bridgeProblem = (code: StatusError['code']) => {
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
const coverOf = (consumer: ListenerView) => {
  if (consumer.story) {
    return ' (this story)';
  }
  return consumer.repo ? ' (whole repo)' : '';
};

/**
 * {level: 'ok'|'warn'|'error', checks, listening, prompt, details, repo, checkout, answering, storyPrompt} from
 * opts.status()'s answer, or its error.
 */
export function healthChecks(
  health: BridgeStatus | null,
  err?: Partial<StatusError> | null,
): Health {
  if (err) {
    const [detail, fix] = bridgeProblem(err.code);
    return { level: 'error', checks: [{ ok: false, bad: true, name: 'Bridge', detail, fix }] };
  }
  const status = health as BridgeStatus; // there's always one without an error
  const checks: HealthCheck[] = [
    { ok: true, name: 'Bridge', detail: `reachable, token accepted (${status.bridge.version})` },
  ];
  if (status.story) {
    checks.push({
      ok: status.story.ok,
      name: 'Story',
      detail: status.story.ok ? `found (${status.story.id})` : 'not found for this page',
    });
  }
  const listening: Partial<Listening> = status.listening || {};
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
    level: !listening.ok || (status.story && !status.story.ok) ? 'warn' : 'ok',
    checks,
    listening: listening.ok,
    prompt: listening.prompt || null,
    details: listening.details || null,
    repo: listening.repo || null,
    checkout: listening.checkout || null,
    answering: listening.answering || null,
    agent: listening.agent || null,
    storyPrompt: listening.story_prompt || null,
  };
}

export const markOf = (check: HealthCheck) => {
  if (check.ok) {
    return '✓';
  }
  return check.bad ? '✗' : '!';
};
export const classOf = (check: HealthCheck) => {
  if (check.ok) {
    return 'ou-hok';
  }
  return check.bad ? 'ou-herr' : 'ou-hwarn';
};

/** What the hint over the Ask box says when no session will answer. */
export function askHintHtml(result: Health, canStart = false) {
  if (result.level === 'error') {
    return html`${result.checks[0].detail}. Questions can't be sent until it's back.`;
  }
  if (!result.prompt) {
    return html`No Claude session is listening; questions will wait. Start one in Claude Code as a background task: <code>once-upon wait --consumer once-upon</code>`;
  }
  const where = result.checkout
    ? html`No idle session to type into? Start Claude Code in <code>${result.checkout}</code> and run`
    : 'No idle session to type into? In Claude Code, run';
  const forRepo = result.repo && ` for ${result.repo}`;
  const more =
    result.details &&
    html` <button type="button" class="ou-promptmore" aria-expanded="false">show details</button>`;
  const long =
    result.details &&
    html`<pre class="ou-promptlong" hidden>Without the once-upon-listen skill, paste this instead:\n${result.details}</pre>`;
  const startTitle = `Types ${result.prompt} into an idle Claude Code session in the repo and presses Enter`;
  const start =
    canStart &&
    html` <button type="button" class="ou-startlisten" title="${startTitle}">Start listening</button>`;
  const note = canStart && html`<div class="ou-startnote" role="status" hidden></div>`;
  return html`<div>No Claude session is listening${forRepo}; questions will wait.${start}</div>${note}<div>${where} <code>${result.prompt}</code>${more}</div>${long}`;
}

/** The line under the Ask box: who answers this story's questions, and the prompt that gives them to one session. */
export function askWhoHtml(result: Health, canStart = false) {
  if (result.level === 'error') {
    return html``;
  }
  const { answering, storyPrompt } = result;
  let start = null;
  if (canStart && storyPrompt && storyPrompt.prompt !== result.prompt) {
    const startTitle =
      `Types ${storyPrompt.prompt} into an idle Claude Code session in the repo and presses Enter: ` +
      "it answers this story's questions from then on, ahead of the repo's listener.";
    start = html` <button type="button" class="ou-startstory" title="${startTitle}">Start listening for this story</button><div class="ou-startnote" role="status" hidden></div>`;
  }
  // a live wait in the session that launched the agent relays to it, whatever the wait covers
  if (answering && answering.agent) {
    return html`Questions go to <b>${answering.agent}</b>, the agent that built this story, through <b>${answering.consumer}</b>.`;
  }
  if (answering && answering.scope === 'story') {
    return html`Answered by <b>${answering.consumer}</b>, the session listening for this story.`;
  }
  // built by an agent, with no live wait in the session that launched it: only that session can reach the agent, so
  // Start listening (which types into an idle session in the repo) isn't offered. The line to run by hand is plain,
  // selectable text: there is no copy button anywhere.
  if (result.agent) {
    const agentNote = html`<b>${result.agent}</b> built this story and has its context.
      Only the Claude session that launched it can pass this story's questions on to it: it does that while it listens.`;
    const byHand =
      storyPrompt &&
      html` To start that, run <code>${storyPrompt.prompt}</code> in the session that launched ${result.agent}.`;
    return answering
      ? html`${agentNote} Until it does, <b>${answering.consumer}</b> answers.${byHand}`
      : html`${agentNote}${byHand}`;
  }
  if (answering) {
    const cover =
      answering.scope === 'repo' ? 'listening for the whole repo' : 'listening for everything';
    return html`Answered by <b>${answering.consumer}</b> (${cover}).${start}`;
  }
  return start ? html`Or have one session answer just this story:${start}` : html``;
}
