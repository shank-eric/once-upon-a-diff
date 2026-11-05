/** A card other than a Backlog item, and its parts: the PR's chips, its sessions, its parent, its listener and its buttons. */
import { html } from '/assets/preact.mjs';
import { ROUTES } from '/assets/contracts/routes.ts';
import type { BoardCard, BoardSession, PrInfo } from '/assets/types.ts';
import { ago, compactAge } from '/assets/domain/time.ts';
import { gateText, plural, repoName } from '/assets/domain/text.ts';
import {
  CardTrees,
  FocusButton,
  isTouch,
  SessionLink,
  useFocus,
  type Api,
} from '/assets/board/shared.ts';
import { act, openStory, reviewCard, typeInto } from '/assets/board/columns/actions.ts';
import { Agent, AgentNotes } from '/assets/board/columns/agent.ts';
import { answerBits } from '/assets/board/columns/story-answers.ts';
import { ContextMeter } from '/assets/ui-kit/components/meter.ts';
import { Chips } from '/assets/ui-kit/components/chip.ts';
import { CopyButton } from '/assets/ui-kit/components/copy-button.ts';
import { ActionButton } from '/assets/ui-kit/components/action-button.ts';

const BUILDING_TEXT = {
  build: 'building the story',
  update: 'updating the story',
  rebuild: 'rebuilding the story',
  fix: 'fixing the code',
  write: 'writing the story',
} as const;

/** The PR's facts as small labels: the one line on merging first, then approvals against required, changes requested, checks, open threads. */
function prChips(pr: PrInfo) {
  const chips: { text: string; tone: 'ok' | 'bad' | 'warn' | 'plain' }[] = [];
  if (pr.state === 'merged') {
    return chips;
  }
  if (pr.merge) {
    chips.push({ text: pr.merge.text, tone: pr.merge.tone });
  }
  const said = (word: string) => !!pr.merge && pr.merge.text.includes(word);
  if (pr.draft && !said('draft')) {
    chips.push({ text: 'Draft', tone: 'plain' });
  }
  if (pr.required !== null || pr.approvals > 0) {
    const text =
      pr.required !== null ? `${pr.approvals}/${pr.required} approved` : `${pr.approvals} approved`;
    chips.push({ text, tone: pr.required !== null && pr.approvals < pr.required ? 'warn' : 'ok' });
  }
  if (pr.review === 'changes_requested' && !said('changes')) {
    chips.push({ text: 'Changes requested', tone: 'bad' });
  }
  const checks = {
    success: ['Checks passing', 'ok'],
    failure: ['Checks failing', 'bad'],
    pending: ['Checks running', 'warn'],
  } as const;
  if (pr.checks && !said('checks')) {
    chips.push({ text: checks[pr.checks][0], tone: checks[pr.checks][1] });
  }
  if (pr.unresolved > 0 && !said('threads')) {
    chips.push({ text: plural(pr.unresolved, 'open thread'), tone: 'warn' });
  }
  return chips;
}

function Session(props: { session: BoardSession; now: number }) {
  const { session, now } = props;
  const time = compactAge(session.since, now);
  return html`<li class=${`ou-board-session ou-board-s-${session.status}`} title=${session.cwd}>
    <span class="ou-board-mark" aria-hidden="true">●</span> <strong>${session.title}</strong> <span class="ou-local-muted">${session.status}${time && ` · ${time}`}</span><${ContextMeter} context=${session.context} />
    ${session.detail && html`<div class="ou-board-agent-note ou-local-muted">${session.detail}</div>`}
  </li>`;
}

/** An agent card's "from <parent session>": a link that brings the parent's iTerm tab forward when it can. */
function From(props: { card: BoardCard; api: Api }) {
  const { card, api } = props;
  if (!card.parent) {
    return 'its session has ended';
  }
  return card.can_focus && card.focus_session
    ? html`from <${FocusButton} bridge=${api.bridge} session=${card.focus_session} class="ou-board-from" title="Bring the parent session's iTerm tab to the front">${card.parent}</${FocusButton}>`
    : html`from ${card.parent}`;
}

/** "listening: <session>" on a story's card: its own listener, linked to the session when its tab is known. */
function Listening(props: { listening: NonNullable<BoardCard['listening']>; api: Api }) {
  const { listening, api } = props;
  return html`<div class="ou-local-muted ou-board-listening">listening: <${SessionLink} bridge=${api.bridge} session=${listening.session} canFocus=${listening.can_focus} name=${listening.title || listening.consumer} title="Bring the listening session's iTerm tab to the front" /></div>`;
}

/**
 * Build story: types the card's line into an idle session of the card, or a finished author's launching session (the
 * bridge picks it and says why when none is). When it can't be typed, Copy hands you the line to paste where you like.
 */
function Build(props: { card: BoardCard; api: Api }) {
  const { card, api } = props;
  const build = card.build as NonNullable<BoardCard['build']>;
  const label = build.blocked ? `Build story (${build.blocked})` : 'Build story';
  const title = build.blocked || `Types ${build.prompt} into the session`;
  const run = () =>
    build.session ? typeInto(api, 'build', build.session, build.prompt, null, card.id) : undefined;
  const copy =
    build.blocked &&
    html`<${CopyButton} text=${build.prompt} class="ou-ui-copy" title=${`Copy: ${build.prompt}`} attrs=${{ 'data-copy-build': card.id }}>Copy</${CopyButton}>`;
  return html`<${ActionButton} class="ou-board-build" attrs=${{ 'data-build': build.session, 'data-prompt': build.prompt }} disabled=${!!build.blocked} onClick=${run} title=${title}>${label}</${ActionButton}>${copy}`;
}

/** Review: a storyless review of the card's branch (the diff, Create pull request and Push), on the local story page. Again on a storyless review, it re-pins it to the branch's tip. */
function Review(props: { card: BoardCard; api: Api }) {
  const { card, api } = props;
  const title = `The diff of ${card.review?.branch}, with Create pull request and Push, without a story`;
  return html`<${ActionButton} class="ou-board-open" attrs=${{ 'data-review': card.id }} onClick=${() => reviewCard(api, card.id)} title=${title}>Review</${ActionButton}>`;
}

/** Whether an agent card's Finish applies: the agent has finished or is waiting on a question, not working or parked on your review. */
const finishable = (card: BoardCard) =>
  card.kind === 'agent' &&
  card.agents.length === 1 &&
  !card.agents[0].review &&
  ['waiting', 'done', 'failed', 'stopped'].includes(card.agents[0].state);

/** Finish: clears a finished agent's card now (the bridge writes the ledger's `[done]` line for one that was still waiting on a question). */
function finishAgent(api: Api, card: BoardCard): Promise<void> | undefined {
  const agent = card.agents[0];
  const sid = agent.sid;
  if (
    agent.state === 'waiting' &&
    !window.confirm(
      `${agent.name} is still waiting on a question. Finish it and write a [done] line to the ledger?`,
    )
  ) {
    return;
  }
  return act(
    'finish it',
    () => api.bridge.ask(ROUTES.boardAgentFinish, { body: { sid, name: agent.name } }),
    api,
  );
}

/** Minutes until a finished agent's card leaves on its own, or 0 when it has no timer. */
const minutesLeft = (agent: BoardCard['agents'][number], now: number) =>
  agent.clears_at ? Math.max(1, Math.ceil((Date.parse(agent.clears_at) - now) / 60000)) : 0;

/** What a finished agent's card says beyond its agent line (which has the outcome and notes path): when the card leaves on its own. */
function Finished(props: { card: BoardCard; now: number }) {
  const { card, now } = props;
  const agent = card.agents[0];
  if (card.kind !== 'agent' || !agent) {
    return null;
  }
  const left = minutesLeft(agent, now);
  return html`${left > 0 && html`<div class="ou-local-muted ou-board-meta" data-agent-clears>leaves the board in ${left} min unless it does something more</div>`}`;
}

/** The agent of a finished agent's own card that the bridge summed up (`summary`), or null. */
const summed = (card: BoardCard) =>
  card.kind === 'agent' && card.agents.length === 1 && card.agents[0].summary
    ? card.agents[0]
    : null;

/**
 * A finished agent's own card in brief, in place of its agent line: what it did, why it is done, and one meta line (its
 * session, when it finished, when the card leaves). Its outcome and task are the card's hover text.
 */
function Summary(props: { card: BoardCard; now: number; api: Api }) {
  const { card, now, api } = props;
  const agent = card.agents[0];
  const summary = agent.summary as NonNullable<typeof agent.summary>;
  const time = compactAge(card.since, now);
  const left = minutesLeft(agent, now);
  const where = card.parent ? html`<${From} card=${card} api=${api} />` : 'session ended';
  const when = time && ` · ${time === 'now' ? 'just now' : `${time} ago`}`;
  return html`${summary.did && html`<div class="ou-board-detail" data-agent-did>${summary.did}</div>`}
    <div class="ou-board-detail" data-agent-why>${summary.why}</div>
    <div class="ou-local-muted ou-board-meta" data-agent-meta>${where}${when}${left > 0 && html` · <span data-agent-clears>leaves in ${left} min</span>`}</div>
    ${agent.notes && html`<${AgentNotes} path=${agent.notes} api=${api} />`}`;
}

/** A card other than a Backlog item: its title, where it is, what is going on, its sessions and agents, and its buttons. */
export function Card(props: { card: BoardCard; now: number; api: Api }) {
  const { card, now, api } = props;
  const { switching, focus } = useFocus(api.bridge);
  const pr = card.pr;
  const time = compactAge(card.since, now);
  const where = [card.repo && card.kind !== 'agent' ? repoName(card.repo) : '', card.branch]
    .filter(Boolean)
    .join(' · ');
  const prLink = pr && html`<a href=${pr.url} target="_blank" rel="noopener">PR #${pr.number}</a>`;
  const merged = pr?.state === 'merged' && time ? `merged ${ago(card.since, now)}` : '';
  const chips = pr ? prChips(pr) : [];
  if (card.story?.approved_at && card.column === 'ship') {
    chips.push({ text: 'Approved, ready to ship', tone: 'ok' });
  }
  if (card.ahead) {
    chips.push({ text: `${card.ahead.count} ahead`, tone: 'warn' });
  }
  const gates = card.agents.filter((agent) => agent.gate).map(gateText);
  // Open story: on a card ready for review, or an approved local story in Ready to ship (a local story is never in Back to you)
  const bits = answerBits(card);
  const { openable, markable } = bits; // Mark reviewed: a local story's card in Ready (a PR story is marked by reviewing it on GitHub)
  if (bits.chip) {
    chips.push({ text: bits.chip, tone: 'warn' });
  }
  const focusTitle = card.can_focus
    ? "Bring this session's iTerm tab to the front"
    : 'No iTerm tab is known for this session';
  // what is going on that the column alone doesn't say
  const notes: string[] = [];
  if (card.building) {
    const building = compactAge(card.building.since, now);
    notes.push(
      `${BUILDING_TEXT[card.building.kind]}${card.building.by ? ` (${card.building.by})` : ''}${building && ` · ${building}`}`,
    );
  }
  if (card.from_backlog?.length) {
    notes.push(`from backlog: ${card.from_backlog.map((item) => item.title).join(', ')}`);
  }
  if (card.story?.unread) {
    notes.push('the story has a new version since you last opened it');
  }
  if (bits.note) {
    notes.push(bits.note);
  }
  if (pr && !pr.mine && pr.author) {
    notes.push(`${pr.author}'s PR${pr.review_requested ? ', your review is requested' : ''}`);
  }
  // a click on the card itself (not on one of its links or buttons) raises the session's tab; on a touch screen there is no tab to raise
  const onCard = (event: MouseEvent) => {
    if (
      card.can_focus &&
      card.focus_session &&
      !(event.target as Element).closest('a, button') &&
      !isTouch()
    ) {
      void focus(card.focus_session);
    }
  };
  const story = card.story;
  const brief = summed(card);
  const hover = brief ? [brief.outcome, brief.task].filter(Boolean).join('\n') : undefined;
  return html`<li class=${`ou-board-card ou-board-c-${card.column}${card.can_focus ? ' ou-board-clickable' : ''}`} data-card=${card.id} data-focus-card=${card.can_focus ? card.focus_session : ''} title=${hover} onClick=${onCard}>
    <div class="ou-board-title" title=${card.title}>${card.title}</div>
    ${brief && html`<${Summary} card=${card} now=${now} api=${api} />`}
    ${card.kind === 'agent' && !brief && html`<div class="ou-local-muted ou-board-meta"><${From} card=${card} api=${api} /></div>`}
    ${!brief && html`<${Finished} card=${card} now=${now} />`}
    ${!brief && html`<div class="ou-local-muted ou-board-meta">${prLink}${prLink && where && ' · '}${where}${(prLink || where) && (merged || time) && ' · '}${merged || time}</div>`}
    ${notes.map((note) => html`<div class="ou-board-detail">${note}</div>`)}
    ${card.listening && html`<${Listening} listening=${card.listening} api=${api} />`}
    ${card.kind === 'session' && card.detail && html`<div class="ou-board-detail">${card.detail}</div>`}
    ${gates.length > 0 && html`<${Chips} class="ou-board-gates" items=${gates} />`}
    ${chips.length > 0 && html`<${Chips} items=${chips} />`}
    ${card.kind === 'session' && card.sessions[0] && html`<div class="ou-local-muted">${card.sessions[0].status}${card.sessions[0].branch ? ` on ${card.sessions[0].branch}` : ''}</div>`}
    ${card.kind === 'work' && card.sessions.length > 0 && html`<ul class="ou-board-sessions">${card.sessions.map((session) => html`<${Session} key=${session.id} session=${session} now=${now} />`)}</ul>`}
    ${card.agents.length > 0 && !brief && html`<ul class="ou-board-agents">${card.agents.map((agent) => html`<${Agent} key=${agent.key} agent=${agent} now=${now} api=${api} byEditor=${card.kind !== 'agent'} />`)}</ul>`}
    <${CardTrees} card=${card} now=${now} api=${api} />
    <div class="ou-board-actions">
      ${card.build && html`<${Build} card=${card} api=${api} />`}
      ${card.review && (!card.story || card.story.storyless) && html`<${Review} card=${card} api=${api} />`}
      ${finishable(card) && html`<${ActionButton} class="ou-board-finish" attrs=${{ 'data-finish-agent': card.id }} onClick=${() => finishAgent(api, card)} title="Clears this card now. It comes back only if the agent does something more">Finish</${ActionButton}>`}
      ${card.focus_session && html`<button type="button" class="ou-board-focus" data-focus=${card.focus_session} disabled=${!card.can_focus || switching} onClick=${() => focus(card.focus_session as string)} title=${focusTitle}>${switching ? 'Switching…' : 'Open in iTerm'}</button>`}
      ${card.column === 'ship' && story?.ship === 'push' && html`<${ActionButton} class="ou-board-push" attrs=${{ 'data-push-local': story.id }} onClick=${() => openStory(api, story.id, true)} title="Opens the story's Push box, which checks GitHub first">Push</${ActionButton}>`}
      ${card.ahead && html`<${ActionButton} class="ou-board-push" attrs=${{ 'data-push-local': card.ahead.story }} onClick=${() => openStory(api, (card.ahead as { story: string }).story, true)} title=${`Opens the story's Push box: the branch is ${card.ahead.count} ahead of GitHub, where this PR is open`}>Push</${ActionButton}>`}
      ${openable && story?.url && html`<a class="ou-board-open" href=${`${story.url}${bits.hash}`} target="_blank" rel="noopener">Open story</a>`}
      ${openable && story && !story.url && html`<${ActionButton} class="ou-board-open" attrs=${{ 'data-open-local': story.id }} onClick=${() => openStory(api, story.id, false)} title="Opens the local story's page">Open story</${ActionButton}>`}
      ${markable && story && html`<${ActionButton} attrs=${{ 'data-mark-local': story.id }} onClick=${() => act('mark it reviewed', () => api.bridge.ask(ROUTES.boardReviewed, { body: { story: story.id } }), api)} title="Done with this story: it leaves Ready for your review">Mark reviewed</${ActionButton}>`}
    </div>
  </li>`;
}
