/**
 * The agent board's data, built in stages. A card is a unit of work: a branch or PR, with the Claude Code sessions and ledger agents
 * working on it inside. Sessions that are not on a branch of their own (the default branch, no repo) are cards of their
 * own. Building it only reads; what a click on the board does to other tools is in ADR-11. The sources:
 *
 *   <sessions dir>/<pid>.json   Claude Code's live-session registry: {pid, sessionId, cwd, name, status, statusUpdatedAt,
 *                               procStart}. A file counts only while its pid is alive (and, when `ps` can say, started
 *                               when procStart says, so a reused pid doesn't revive it). A session's branch is its
 *                               checkout's current one (`git rev-parse`).
 *   a status source             the terminal's richer status (sources.ts)
 *   ledger and progress files   the background agents (ledger.ts)
 *   PR stories                  the built stories (review/story-lists.ts): each is a PR, with its branch, and whether you have
 *                               reviewed it. Merged ones stay a day, as Done.
 *   local stories               a branch's story before any PR (`once-upon local`): on a card of that repo and branch (a
 *                               branch-only card when nothing else is there, while it waits for review), as its story
 *                               when the branch has no PR story, with the same Ready and Back to you rules
 *   GitHub, through AutoReview  per PR: approvals, merge state, checks, new comments (review/auto-review.ts). It is asked in
 *                               the background and the board reads what it has, so a poll never waits for GitHub. A
 *                               session's branch without a story is looked up the same way.
 *   <projects dir>              each session's transcript, to tell a session with no prompt yet (blank.ts): those are a
 *                               strip in the Idle lane, not cards; and for its title when the tab's name says nothing
 *                               (titles.ts)
 *   <home>/statusline/          each session's context use and the usage limits, as a status line script copies them
 *                               (statusline.ts)
 *
 * The board shows your own work: sessions on this Mac, and PRs you authored (isShown). Columns follow the work to
 * merge (columns.ts). A lane is keyed by the repo's owner/name (else the folder's name) and labeled by the short name unless two lanes share it: the page puts a lane's label right above its
 * cards inside each column. Sessions share a card only on the same live branch (a PR still open, or a story); any other
 * session is a card of its own, titled by the session. An agent is a card of its own, on its own lane (its `lane:<name>`
 * tag, else its registered repo's, else its parent's), with a "from <parent session>" link, only while it is running or
 * waiting; a finished one has no card. It is nested inside the card its registered repo and branch, PR or card point to,
 * if there is one (agent-home.ts), and never by what its task says.
 */
import { unreadAnswers } from '../../inbox/conversation.ts';
import { Inbox } from '../../inbox/inbox.ts';
import type { BacklogStore } from '../../backlog/backlog.ts';
import type { BlankSessions } from '../../../adapters/claude-sessions/blank.ts';
import { listenersLane } from '../../sessions/listening.ts';
import type { ListeningInput } from '../../sessions/listening.ts';
import type { SessionTitles } from '../../../adapters/claude-sessions/titles.ts';
import type { WorktreeScanner } from '../../worktrees/worktrees.ts';
import type { BoardData, BoardStatus } from '@once-upon-a-diff/protocol/types';
import { claimViews, placeAgents } from './agents.ts';
import { editorsOf } from './editors.ts';
import { claimerKeys, heldKeys } from '../../backlog/claims.ts';
import { addBacklogCards, nestClaimedAgents, readBacklogLinks } from './backlog.ts';
import { buildCards, placeCards } from './cards.ts';
import type { CardFacts } from './cards.ts';
import { isStandingHelper, standingHelpers } from './helpers.ts';
import { groupLanes } from './lanes.ts';
import { laneLabels, resolveLane } from '@once-upon-a-diff/protocol/domain/lane-key';
import { markListening } from './listeners.ts';
import { placeSessions, readLive, readSessionFacts } from './sessions.ts';
import { blankStrip, voiceOf } from './strips.ts';
import type { BuildContext, StoryFacts } from './types.ts';
import { collectWorks } from './works.ts';
import { worktreeSection } from './worktrees.ts';

/** What the Board keeps between builds and hands to one. */
export interface BoardState {
  /** when each session entered its status, since the registry's time is for its own */
  seen: Map<string, { status: BoardStatus; since: number }>;
  blank: BlankSessions;
  titles: SessionTitles;
  listenerSessions: Map<string, string>;
  backlog: BacklogStore;
  scanner: WorktreeScanner;
}

/** A build's answer, with what the Board keeps from it. */
export interface BuiltBoard {
  data: BoardData;
  /** the listening rules' input, for the panel's Start listening (Board.listenSessions) */
  listening: ListeningInput;
  /** `state.seen` as the build leaves it */
  seen: BoardState['seen'];
}

/**
 * The stages, in order: the live sessions; the works (PRs, branches and local stories); what else is known of the
 * sessions; where each session goes; the cards; the agents; the columns; who listens; the Backlog; the worktrees; the
 * lanes. Each stage is a function in its own file taking what it needs, and none of them touches the Board's caches
 * except through `ctx.lookups`. The few that change what an earlier stage returned (`works`, `cards`) say so.
 */
export async function buildBoard(ctx: BuildContext, state: BoardState): Promise<BuiltBoard> {
  const { now, nowMs, settings } = ctx;
  const unreadById = unreadAnswers(ctx.home, new Inbox(ctx.home), nowMs);
  const read = await readLive(ctx);
  // a standing helper is no card, no running work and no owner of a backlog card: it is held out of every stage's agents
  // and has its row only (helpers.ts)
  const standing = read.agents.filter(isStandingHelper);
  const liveFacts = { ...read, agents: read.agents.filter((agent) => !isStandingHelper(agent)) };
  const { live, agents, beats, picked } = liveFacts;
  const collected = collectWorks(ctx);
  const { works, stories, localStoryList } = collected;
  const cardFacts: CardFacts = {
    unreadById,
    shipById: collected.shipById,
    localCheckouts: collected.localCheckouts,
  };

  const facts = await readSessionFacts(ctx, liveFacts, {
    blank: state.blank,
    titles: state.titles,
    listenerSessions: state.listenerSessions,
  });
  const {
    waits,
    parents,
    sessionByPid,
    quiet,
    voiceFiles,
    phone,
    voiceStart,
    voicePaused,
    statusLines,
  } = facts;

  const placed = placeSessions(ctx, liveFacts, facts, works, state.seen);
  const { sessionCards, quietViews, blankViews, repoBySession } = placed;
  const pin = placed.pin;

  // cards for the works: PR details from what GitHub last said
  const cards = buildCards(ctx, cardFacts, works, sessionCards);

  // the Backlog's items, and who claimed which: a claimed card shows its agent, so that agent has no card of its own
  const backlogItems = state.backlog.items();
  const held = heldKeys(backlogItems, agents);
  // the editors, and which agent each controls: by the session an agent was launched from (editors.ts)
  const editing = editorsOf({
    editors: read.editors,
    agents,
    beats,
    live,
    canFocus: (session) => picked.source.name === 'iterm' && read.known.has(session),
    claimers: claimerKeys(backlogItems, agents),
    nowMs,
  });
  const claimed = claimViews(backlogItems, agents, beats, nowMs, editing.editorOf);

  // agents: nested in the card their registered repo, branch, PR or card point to, else a card of their own on their own lane
  cards.push(
    ...placeAgents(ctx, cards, {
      agents,
      beats,
      pin,
      held,
      items: backlogItems,
      editorOf: editing.editorOf,
    }),
  );

  // a claimed agent goes on its card's branch's card now, so its state counts when the columns are decided
  nestClaimedAgents(backlogItems, cards, claimed);

  // the columns, now that every card has its sessions and agents
  const byStory = new Map<string, StoryFacts>(
    [...stories, ...localStoryList].map((story) => [story.id, story]),
  );
  placeCards(cards, byStory);

  const { listening, sessionViews } = markListening(ctx, cards, {
    waits,
    parents,
    sessionByPid,
    quietViews,
    busyListeners: new Set([...quiet].filter(([, busy]) => busy).map(([id]) => id)),
    blankViews,
    pin,
    repoBySession,
  });

  // the Backlog column: open items, and started ones are marked onto the work cards they became
  const links = await readBacklogLinks(ctx, {
    items: backlogItems,
    live,
    agents,
    beats,
    works,
    localCheckouts: cardFacts.localCheckouts,
    repoBySession,
    sessionViews,
  });
  cards.push(
    ...addBacklogCards(
      ctx,
      cards,
      backlogItems,
      links,
      {
        sessionViews,
        quietViews,
        pin,
        repoBySession,
      },
      claimed,
      agents,
    ),
  );

  const worktrees = settings.worktrees
    ? worktreeSection({
        scanner: state.scanner,
        home: ctx.home,
        review: ctx.review,
        cards,
        live,
        sessionViews,
        agents,
        keepBranches: settings.keepBranches,
        nowMs,
      })
    : null;

  // an agent's lane tag is a short name: now that every repo the board knows is in (cards, backlog cards, blank
  // sessions, worktrees), it becomes the one owner/name that has that name, so a repo is one lane. A lane that came
  // from anything else (the agent's registered repo, or its parent's lane, which may be a folder) is already a key and stays
  const repoLanes = [
    ...cards.map((card) => card.lane),
    ...blankViews.map((one) => one.lane),
    ...editing.editors.map((editor) => editor.lane),
    ...(worktrees?.items ?? []).map((tree) => tree.lane),
  ];
  const tags = new Map(
    agents.flatMap((agent) =>
      agent.lane ? [[`agent:${agent.sid}:${agent.name}`, agent.lane]] : [],
    ),
  );
  for (const card of cards) {
    const tag = card.kind === 'agent' ? tags.get(card.id) : undefined;
    if (tag) {
      card.lane = resolveLane(tag, repoLanes);
    }
  }

  // lanes: one per repo (or lane tag), the cards grouped by the page into columns; the labels are the board's one
  // answer, the short name unless two lanes share it (the Worktrees lane's rows carry theirs)
  const labels = laneLabels([
    ...cards.map((card) => card.lane),
    ...blankViews.map((one) => one.lane),
    ...editing.editors.map((editor) => editor.lane),
    ...(worktrees?.items ?? []).map((tree) => tree.lane),
  ]);
  for (const tree of worktrees?.items ?? []) {
    tree.lane_label = labels.get(tree.lane);
  }
  editing.relabel(labels);
  // an agent card launched by an editor says so, as the voice session's say "Voice session"
  for (const card of cards) {
    const editor = card.kind === 'agent' ? card.agents[0]?.editor : null;
    if (editor) {
      card.parent = `Editor · ${editor.label}`;
      // and "from" brings the editor's own registered session forward, not a tab matched by session-id prefix
      card.focus_session = editor.session;
      card.can_focus = editor.can_focus;
    }
  }
  const lanes = groupLanes(cards, labels);
  const data: BoardData = {
    at: now.toISOString(),
    status_source: picked.source.name,
    warning: picked.warning,
    voice: voiceOf(pin, voiceFiles, agents, nowMs, settings.voiceDir as string),
    phone,
    voice_start: voiceStart,
    voice_paused: voicePaused,
    editors: editing.editors,
    listeners: listenersLane(waits, listening),
    helpers: standingHelpers(standing, live, sessionViews, nowMs),
    blank: blankStrip(blankViews, labels),
    lanes,
    worktrees,
    usage: statusLines.usage,
  };
  return { data, listening, seen: placed.seen };
}
