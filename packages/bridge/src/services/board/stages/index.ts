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
 * merge (columns.ts). A lane is the repo's name (else the folder's name): the page puts a lane's label right above its
 * cards inside each column. Sessions share a card only on the same live branch (a PR still open, or a story); any other
 * session is a card of its own, titled by the session. A ledger agent is a card of its own, on its own lane (its
 * `lane:<name>` tag, else the repo its task names, else its parent's), with a "from <parent session>" link, only while
 * it is running or waiting; a finished one has no card. It is nested inside its parent's card only when tightly tied to
 * it, on the same branch or PR (agent-home.ts).
 */
import { unreadAnswers } from '../../inbox/conversation.ts';
import { Inbox } from '../../inbox/inbox.ts';
import type { BacklogStore } from '../../backlog/backlog.ts';
import type { BlankSessions } from '../../../adapters/claude-sessions/blank.ts';
import { listenersLane } from '../../sessions/listening.ts';
import type { ListeningInput } from '../../sessions/listening.ts';
import type { SessionTitles } from '../../../adapters/claude-sessions/titles.ts';
import type { WorktreeScanner } from '../../worktrees/worktrees.ts';
import type { BoardData, BoardStatus } from '@once-upon-a-diff/shared/types';
import { placeAgents } from './agents.ts';
import { addBacklogCards, readBacklogLinks } from './backlog.ts';
import { buildCards, placeCards } from './cards.ts';
import type { CardFacts } from './cards.ts';
import { groupLanes } from './lanes.ts';
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
  const liveFacts = await readLive(ctx);
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
  });
  const { waits, parents, sessionByPid, voiceFiles, phone, statusLines } = facts;

  const placed = placeSessions(ctx, liveFacts, facts, works, state.seen);
  const { sessionCards, quietViews, blankViews, repoBySession } = placed;
  const pin = placed.pin;

  // cards for the works: PR details from what GitHub last said
  const cards = buildCards(ctx, cardFacts, works, sessionCards);

  // agents: a card of their own, on their own lane, unless tightly tied to their parent's card (tiedToParent)
  cards.push(...placeAgents(ctx, cards, { agents, beats, pin }));

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
    blankViews,
    pin,
    repoBySession,
  });

  // the Backlog column: open items, and started ones are marked onto the work cards they became
  const backlogItems = state.backlog.items();
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
    ...addBacklogCards(ctx, cards, backlogItems, links, {
      listening,
      sessionViews,
      blankViews,
      quietViews,
      pin,
      repoBySession,
    }),
  );

  // lanes: one per repo (or lane tag), the cards grouped by the page into columns
  const lanes = groupLanes(cards);
  const data: BoardData = {
    at: now.toISOString(),
    status_source: picked.source.name,
    warning: picked.warning,
    voice: voiceOf(pin, voiceFiles, agents, nowMs, settings.voiceDir as string),
    phone,
    listeners: listenersLane(waits, listening),
    blank: blankStrip(blankViews),
    lanes,
    worktrees: settings.worktrees
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
      : null,
    usage: statusLines.usage,
  };
  return { data, listening, seen: placed.seen };
}
