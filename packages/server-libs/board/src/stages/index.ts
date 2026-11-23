/**
 * The agent board's data, built in stages. A card is a unit of work: a branch or PR, with the Claude Code sessions and registered agents
 * working on it inside. Sessions that are not on a branch of their own (the default branch, no repo) are cards of their
 * own. Building it only reads; what a click on the board does to other tools is in ADR-11. The sources:
 *
 *   <sessions dir>/<pid>.json   Claude Code's live-session registry: {pid, sessionId, cwd, name, status, statusUpdatedAt,
 *                               procStart}. A file counts only while its pid is alive (and, when `ps` can say, started
 *                               when procStart says, so a reused pid doesn't revive it). A session's branch is its
 *                               checkout's current one (`git rev-parse`).
 *   a status source             the terminal's richer status (sources.ts)
 *   the agent registry          the background agents (agents.jsonl, ledger/read.ts)
 *   PR stories                  the built stories (review/story-lists.ts): each is a PR, with its branch, and whether you have
 *                               reviewed it. Merged ones stay a day, as Done.
 *   local stories               a branch's story before any PR (`once-upon local`): on a card of that repo and branch (a
 *                               branch-only card when nothing else is there, while it waits for review), as its story
 *                               when the branch has no PR story, with the same Ready and Back to you rules
 *   GitHub, through AutoReview  per PR: approvals, merge state, checks, new comments (review/github-watcher.ts). It is asked in
 *                               the background and the board reads what it has, so a poll never waits for GitHub. A
 *                               session's branch without a story is looked up the same way.
 *   <projects dir>              each session's transcript, to tell a session with no prompt yet (blank-sessions.ts): those are a
 *                               strip in the Idle lane, not cards; and for its title when the tab's name says nothing
 *                               (titles.ts)
 *   <home>/statusline/          each session's context use and the usage limits, as a status line script copies them
 *                               (statusline.ts)
 *
 * The board shows your own work: sessions on this Mac, and PRs you authored (isShown). Columns follow the work to
 * merge (columns.ts). A lane is keyed by the repo's owner/name (else the folder's name) and labeled by the short name unless two lanes share it: the page puts a lane's label right above its
 * cards inside each column. Sessions share a card only on the same live branch (a PR still open, or a story); any other
 * session is a card of its own, titled by the session. An agent is a card of its own, on its own lane (its registered
 * repo's, else its parent's), with a "from <parent session>" link, only while it is running or waiting; a finished one has no
 * card. It is nested inside the card its run names (`--card`), and never by what its task says.
 */
import { unreadAnswers } from '@once-upon-a-diff/state/queues/requests/conversation';
import { Inbox } from '@once-upon-a-diff/state/queues/requests/inbox';
import { isListed } from '@once-upon-a-diff/state/queues/backlog/backlog';
import type { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import type { BlankSessions } from '@once-upon-a-diff/adapters/claude-sessions/blank-sessions';
import { listenersLane } from '@once-upon-a-diff/core/features/listeners/service';
import { listenCandidates } from '@once-upon-a-diff/core/features/sessions/listening';
import type { ListeningInput } from '@once-upon-a-diff/core/features/sessions/listening';
import type { SubagentLiveness } from '@once-upon-a-diff/adapters/claude-sessions/subagent-liveness';
import type { SessionTitles } from '@once-upon-a-diff/adapters/claude-sessions/titles';
import type { WorktreeScanner } from '@once-upon-a-diff/state/records/worktrees/worktrees';
import type { BoardData } from '@once-upon-a-diff/contracts/types';
import { runViews, placeAgents } from './agents.ts';
import { editorsOf } from './editors.ts';
import { carriedKeys } from '@once-upon-a-diff/state/queues/backlog/phase';
import {
  addBacklogCards,
  ignoreStoriesBeforePark,
  markLandedWorks,
  nestCardAgents,
  keepWorkWorking,
  readBacklogLinks,
} from './backlog.ts';
import { buildCards, placeCards } from './cards.ts';
import type { CardFacts } from './cards.ts';
import { isStandingHelper, standingHelpers } from './helpers.ts';
import { groupLanes } from './lanes.ts';
import { laneLabels } from '@once-upon-a-diff/terms/lane-key';
import { markListening } from './listeners.ts';
import { voiceLines } from '@once-upon-a-diff/adapters/larmor';
import { learnCards } from './learned.ts';
import { NOTHING_LEARNED } from '@once-upon-a-diff/core/features/cards/learned';
import type { LearnedCards } from '@once-upon-a-diff/core/features/cards/learned';
import { placeSessions, readLive, readSessionFacts, type SeenSession } from './sessions.ts';
import { blankStrip, voiceOf } from './strips.ts';
import type { BuildContext, StoryFacts } from './types.ts';
import { movedCards } from './moved.ts';
import { addSubagentRows } from './subagents.ts';
import { collectWorks } from './works.ts';
import { worktreeSection } from './worktrees.ts';

/** What the Board keeps between builds and hands to one. */
export interface BoardState {
  /** when each session entered its status, since the registry's time is for its own */
  seen: Map<string, SeenSession>;
  blank: BlankSessions;
  titles: SessionTitles;
  /** where each open run's subagent transcript last changed (dead-runs.ts) */
  liveness: SubagentLiveness;
  listenerSessions: Map<string, string>;
  backlog: BacklogStore;
  scanner: WorktreeScanner;
  /** work out what the card keeper is to write (`BuiltBoard.learned`); left off, it is nothing */
  learn?: boolean;
}

/** A build's answer, with what the Board keeps from it. */
export interface BuiltBoard {
  data: BoardData;
  /** the listening rules' input, for the panel's Start listening (Board.listenSessions) */
  listening: ListeningInput;
  /** `state.seen` as the build leaves it */
  seen: BoardState['seen'];
  /** what the build learned for the card keeper (stages/learned.ts): nothing unless `state.learn` */
  learned: LearnedCards;
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
  const read = await readLive(ctx, state.liveness);
  // a standing helper is no card, no running work and no owner of a backlog card: it is held out of every stage's agents
  // and has its row only (helpers.ts)
  const standing = read.agents.filter(isStandingHelper);
  const liveFacts = { ...read, agents: read.agents.filter((agent) => !isStandingHelper(agent)) };
  const { live, agents, picked } = liveFacts;
  // `storedCards` is every stored card (an agent's, a session's, a PR's, a story's too): the board joins runs, sessions and works
  // to them. `backlogItems` is the listed ones, the cards a person added: what the Backlog column and the stages that act on a
  // person's card read
  const storedCards = state.backlog.items();
  const backlogItems = storedCards.filter(isListed);
  const collected = collectWorks(ctx, storedCards);
  const { works, stories, localStoryList } = collected;
  const cardFacts: CardFacts = {
    unreadById,
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

  // the Backlog's items: a card shows the agents whose runs name it, so those agents have no card of their own
  const placed = placeSessions(ctx, liveFacts, facts, works, state.seen, storedCards);
  const { sessionCards, quietViews, blankViews, repoBySession } = placed;
  const pin = placed.pin;
  // the pinned voice session's last lines, from voice_ctl: asked only when the strip is shown
  const lines =
    pin && settings.larmorDir
      ? await voiceLines(settings.larmorDir, pin.view.id, !!voiceFiles?.on)
      : [];

  // cards for the works: PR details from what GitHub last said
  const cards = buildCards(ctx, cardFacts, works, sessionCards);

  // an agent whose run names a card that exists is that card's (phase.ts)
  const held = carriedKeys(backlogItems, agents);
  // the editors, and which agent each controls: by the session an agent was launched from (editors.ts)
  const editing = editorsOf({
    editors: read.editors,
    agents,
    live,
    canFocus: (session) => read.known.get(session)?.tab === true,
    nowMs,
  });
  const views = runViews(backlogItems, agents, nowMs, editing.editorOf);

  // agents: nested in the card their registered repo, branch, PR or card point to, else a card of their own on their own lane
  cards.push(
    ...placeAgents(ctx, cards, {
      agents,
      pin,
      editorViews: placed.editorViews,
      held,
      items: backlogItems,
      stored: storedCards,
      editorOf: editing.editorOf,
      // with the scanner off its facts are not kept up, so no author waits on a merge state read from them
      trees: settings.worktrees ? state.scanner.read().items : [],
    }),
  );

  // an agent whose run names a card goes on its branch's card now, so its state counts when the columns are decided
  nestCardAgents(backlogItems, cards, views);
  keepWorkWorking(backlogItems, cards);
  const byStory = new Map<string, StoryFacts>(
    [...stories, ...localStoryList].map((story) => [story.id, story]),
  );
  markLandedWorks(backlogItems, cards, nowMs, byStory, agents);
  ignoreStoriesBeforePark(backlogItems, cards, byStory, agents);

  // the columns, now that every card has its sessions and agents; a Ready card whose branch moved past its story is Working
  placeCards(
    cards,
    byStory,
    movedCards(
      cards,
      collected.toldHeads,
      settings.worktrees ? state.scanner.read().items : [],
      ctx.lookups.movedPast,
      agents,
      nowMs,
    ),
    placed.launched,
  );

  const { listening, sessionViews } = markListening(ctx, cards, {
    waits,
    parents,
    sessionByPid,
    quietViews,
    busyListeners: new Set([...quiet].filter(([, busy]) => busy).map(([id]) => id)),
    blankViews,
    editorViews: placed.editorViews,
    pin,
    repoBySession,
    trees: settings.worktrees ? state.scanner.read().items : [],
  });

  // the Backlog column: open items, and started ones are marked onto the work cards they became
  const links = await readBacklogLinks(ctx, {
    items: backlogItems,
    live,
    agents,
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
      { trees: settings.worktrees ? state.scanner.read().items : [] },
      views,
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

  // lanes: one per repo, the cards grouped by the page into columns; the labels are the board's one
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
    voice: voiceOf(pin, voiceFiles, agents, nowMs, lines),
    phone,
    voice_start: voiceStart,
    voice_paused: voicePaused,
    editors: editing.editors,
    listeners: listenersLane(waits, {
      ...listening,
      candidatesFor: (repo) => listenCandidates(repo, listening),
    }),
    helpers: standingHelpers(standing, live, sessionViews, nowMs),
    blank: blankStrip(blankViews, labels),
    lanes,
    worktrees,
    usage: statusLines.usage,
  };
  // the subagents nobody registered, as light rows on their session's card or strip entry (subagents.ts)
  await addSubagentRows(ctx, state.liveness, data, [...read.agents, ...read.editors]);
  const learned = state.learn ? await learnCards(ctx, works, placed.learned) : NOTHING_LEARNED;
  return { data, listening, seen: placed.seen, learned };
}
