/** A card other than a Backlog item, and its parts: the PR's chips, its sessions, its parent, its listener and its buttons. */
import { html } from '/assets/preact.mjs';
import { ROUTES } from '/assets/contracts/routes.ts';
import type { BoardCard, BoardSession, PrInfo } from '/assets/types.ts';
import { ago, compactAge } from '/assets/terms/time.ts';
import { gateText, plural, repoName } from '/assets/terms/text.ts';
import {
  CardTrees,
  FocusButton,
  isTouch,
  OUTSIDE_CHIP,
  RecordFix,
  SessionLink,
  useFocus,
  type Api,
} from '/assets/board/shared.ts';
import { act, openStory, reviewCard, typeInto } from '/assets/board/columns/actions.ts';
import { AgentList, AgentNotes } from '/assets/board/columns/agent.ts';
import {
  answerBits,
  approvedToShip,
  type AnswerBits,
} from '/assets/board/columns/story-answers.ts';
import { ContextMeter } from '/assets/ui-kit/components/meter.ts';
import { Chips } from '/assets/ui-kit/components/chip.ts';
import { SubagentList } from '/assets/ui-kit/components/subagents.ts';
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
  const chips: { text: string; mark: 'ok' | 'bad' | 'warn' | 'plain' }[] = [];
  if (pr.state === 'merged') {
    return chips;
  }
  if (pr.merge) {
    chips.push({ text: pr.merge.text, mark: pr.merge.tone });
  }
  const said = (word: string) => !!pr.merge && pr.merge.text.includes(word);
  if (pr.draft && !said('draft')) {
    chips.push({ text: 'Draft', mark: 'plain' });
  }
  if (pr.required !== null || pr.approvals > 0) {
    const text =
      pr.required === null ? `${pr.approvals} approved` : `${pr.approvals}/${pr.required} approved`;
    chips.push({ text, mark: pr.required !== null && pr.approvals < pr.required ? 'warn' : 'ok' });
  }
  if (pr.review === 'changes_requested' && !said('changes')) {
    chips.push({ text: 'Changes requested', mark: 'bad' });
  }
  const checks = {
    success: ['Checks passing', 'ok'],
    failure: ['Checks failing', 'bad'],
    pending: ['Checks running', 'warn'],
  } as const;
  if (pr.checks && !said('checks')) {
    chips.push({ text: checks[pr.checks][0], mark: checks[pr.checks][1] });
  }
  if (pr.unresolved > 0 && !said('threads')) {
    chips.push({ text: plural(pr.unresolved, 'open thread'), mark: 'warn' });
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

/** The labels on a card: its PR's facts, then what is unconfirmed, approved, ahead, and what the story's answers say. */
function cardChips(card: BoardCard, bits: AnswerBits) {
  const pr = card.pr;
  const chips = pr ? prChips(pr) : [];
  if (pr && card.pr_unconfirmed) {
    // GitHub has not answered lately (or yet): the PR's facts may be out of date
    chips.push({ text: 'unconfirmed', mark: 'plain' });
  }
  if (approvedToShip(card)) {
    chips.push({ text: 'Approved, ready to ship', mark: 'ok' });
  }
  if (card.ahead) {
    chips.push({ text: `${card.ahead.count} ahead`, mark: 'warn' });
  }
  if (card.outside) {
    chips.push(OUTSIDE_CHIP);
  }
  if (bits.chip) {
    chips.push({ text: bits.chip, mark: 'warn' });
  }
  return chips;
}

/** What a card's build is doing, and who for, and for how long. */
function buildingNote(building: NonNullable<BoardCard['building']>, now: number): string {
  const age = compactAge(building.since, now);
  return `${BUILDING_TEXT[building.kind]}${building.by ? ` (${building.by})` : ''}${age && ` · ${age}`}`;
}

/** The lines on a card for what is going on that the column alone doesn't say. */
function cardNotes(card: BoardCard, bits: AnswerBits, now: number): string[] {
  const pr = card.pr;
  const notes: string[] = [];
  if (card.building) {
    notes.push(buildingNote(card.building, now));
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
  return notes;
}

/** A card's one meta line: its PR's link, where it is (repo and branch), and when (merged, or how long ago). */
function Place(props: { card: BoardCard; now: number }) {
  const { card, now } = props;
  const pr = card.pr;
  const time = compactAge(card.since, now);
  const where = [card.repo && card.kind !== 'agent' ? repoName(card.repo) : '', card.branch]
    .filter(Boolean)
    .join(' · ');
  const prLink = pr && html`<a href=${pr.url} target="_blank" rel="noopener">PR #${pr.number}</a>`;
  const merged = pr?.state === 'merged' && time ? `merged ${ago(card.since, now)}` : '';
  const when = merged || time;
  return html`<div class="ou-local-muted ou-board-meta">${prLink}${prLink && where && ' · '}${where}${(prLink || where) && when && ' · '}${when}</div>`;
}

/** The top of a card, under its title: a finished agent in brief, or who it is from, whether it is leaving, and where and when. */
function CardTop(props: {
  card: BoardCard;
  brief: BoardCard['agents'][number] | null;
  now: number;
  api: Api;
}) {
  const { card, brief, now, api } = props;
  if (brief) {
    return html`<${Summary} card=${card} now=${now} api=${api} />`;
  }
  return html`${card.kind === 'agent' && html`<div class="ou-local-muted ou-board-meta"><${From} card=${card} api=${api} /></div>`}
    <${Finished} card=${card} now=${now} />
    <${Place} card=${card} now=${now} />`;
}

/** The middle of a card: what is going on, its listener, its labels, and its sessions and agents. */
function CardBody(props: {
  card: BoardCard;
  hasBrief: boolean;
  bits: AnswerBits;
  now: number;
  api: Api;
}) {
  const { card, hasBrief, bits, now, api } = props;
  const gates = card.agents.filter((agent) => agent.gate).map(gateText);
  const chips = cardChips(card, bits);
  const session = card.sessions[0];
  const isSession = card.kind === 'session';
  const isAgent = card.kind === 'agent';
  return html`${cardNotes(card, bits, now).map((note) => html`<div class="ou-board-detail">${note}</div>`)}
    ${card.listening && html`<${Listening} listening=${card.listening} api=${api} />`}
    ${isSession && card.detail && html`<div class="ou-board-detail">${card.detail}</div>`}
    ${gates.length > 0 && html`<${Chips} class="ou-board-gates" items=${gates} />`}
    ${chips.length > 0 && html`<${Chips} items=${chips} />`}
    ${isSession && session && html`<div class="ou-local-muted">${session.status}${session.branch ? ` on ${session.branch}` : ''}</div>`}
    ${card.kind === 'work' && card.sessions.length > 0 && html`<ul class="ou-board-sessions">${card.sessions.map((each) => html`<${Session} key=${each.id} session=${each} now=${now} />`)}</ul>`}
    ${card.agents.length > 0 && !hasBrief && html`<${AgentList} agents=${card.agents} now=${now} api=${api} byEditor=${!isAgent} />`}
    ${card.subagents && !isAgent && html`<${SubagentList} subagents=${card.subagents} now=${now} />`}
    <${CardTrees} card=${card} now=${now} api=${api} />`;
}

/** The buttons at the foot of a card. `focus` and `switching` are the card's, so a click on the card and the button share one. */
function CardActions(props: {
  card: BoardCard;
  bits: AnswerBits;
  api: Api;
  focus: (session: string) => Promise<void> | void;
  switching: boolean;
}) {
  const { card, bits, api, focus, switching } = props;
  const story = card.story;
  const focusTitle = card.can_focus
    ? "Bring this session's iTerm tab to the front"
    : 'No iTerm tab is known for this session';
  const storyless = !card.story || card.story.storyless;
  return html`<div class="ou-board-actions">
      ${card.build && html`<${Build} card=${card} api=${api} />`}
      ${card.review && storyless && html`<${Review} card=${card} api=${api} />`}
      ${card.outside && html`<${RecordFix} card=${card} api=${api} />`}
      ${finishable(card) && html`<${ActionButton} class="ou-board-finish" attrs=${{ 'data-finish-agent': card.id }} onClick=${() => finishAgent(api, card)} title="Clears this card now. It comes back only if the agent does something more">Finish</${ActionButton}>`}
      ${card.focus_session && html`<button type="button" class="ou-board-focus" data-focus=${card.focus_session} disabled=${!card.can_focus || switching} onClick=${() => focus(card.focus_session as string)} title=${focusTitle}>${switching ? 'Switching…' : 'Open in iTerm'}</button>`}
      ${bits.openable && story?.url && html`<a class="ou-board-open" href=${`${story.url}${bits.hash}`} target="_blank" rel="noopener">Open story</a>`}
      ${bits.openable && story && !story.url && html`<${ActionButton} class="ou-board-open" attrs=${{ 'data-open-local': story.id }} onClick=${() => openStory(api, story.id)} title="Opens the local story's page">Open story</${ActionButton}>`}
    </div>`;
}

/** A card other than a Backlog item: its title, where it is, what is going on, its sessions and agents, and its buttons. */
export function Card(props: { card: BoardCard; now: number; api: Api }) {
  const { card, now, api } = props;
  const { switching, focus } = useFocus(api.bridge);
  const bits = answerBits(card);
  const brief = summed(card);
  const hover = brief ? [brief.outcome, brief.task].filter(Boolean).join('\n') : undefined;
  // a click on the card itself (not on one of its links or buttons) raises the session's tab; on a touch screen there is no tab to raise
  const onCard = (event: MouseEvent) => {
    const canRaise = !!card.can_focus && !!card.focus_session && !isTouch();
    const onControl = !!(event.target as Element).closest('a, button');
    if (canRaise && !onControl) {
      void focus(card.focus_session as string);
    }
  };
  return html`<li class=${`ou-board-card ou-board-c-${card.column}${card.can_focus ? ' ou-board-clickable' : ''}`} data-card=${card.id} data-focus-card=${card.can_focus ? card.focus_session : ''} title=${hover} onClick=${onCard}>
    <div class="ou-board-title" title=${card.title}>${card.title}</div>
    <${CardTop} card=${card} brief=${brief} now=${now} api=${api} />
    <${CardBody} card=${card} hasBrief=${!!brief} bits=${bits} now=${now} api=${api} />
    <${CardActions} card=${card} bits=${bits} api=${api} focus=${focus} switching=${switching} />
  </li>`;
}
