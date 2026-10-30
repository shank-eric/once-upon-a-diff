/**
 * The live sessions: what the registry, the status source, the ledger and the transcripts say of them, and which card
 * each goes on. A session on a branch of its own joins that branch's work (works.ts); a session standing alone is a card
 * of its own (cards.ts); the voice session is pinned above the columns; a session that only listens is shown in the
 * Listeners lane; one with no prompt yet is a chip in the Blank strip.
 */
import path from 'node:path';
import { sameRepo } from '../../config/repos.ts';
import { DEFAULT_BRANCHES } from '../../review/story-lists.ts';
import { readAgents, type LedgerAgent } from '../../ledger/ledger.ts';
import type { BlankSessions } from '../../../adapters/claude-sessions/blank.ts';
import type { SessionTitles } from '../../../adapters/claude-sessions/titles.ts';
import { readStatusLines } from '../../../adapters/claude-sessions/statusline.ts';
import { awayOn, bridgeUp, phoneReady, readVoice } from '../../../adapters/larmor.ts';
import { listeningOnly, parentMap } from '../../sessions/listening.ts';
import { listeners, type Listener } from '../../listeners/listeners.ts';
import { pickSource } from '../../sessions/sources.ts';
import { type SourceStatus, type StatusSource } from '../../../adapters/iterm.ts';
import { type LiveSession } from '../../../adapters/claude-sessions/registry.ts';
import type {
  BoardBeat,
  BoardCard,
  BoardData,
  BoardSession,
  BoardStatus,
} from '@once-upon-a-diff/shared/types';
import { sessionCard } from './cards.ts';
import { laneOf } from './lanes.ts';
import { liveSessions } from '../../../adapters/claude-sessions/registry.ts';
import type { BuildContext, PinnedVoice, SessionView, Work } from './types.ts';
import { branchOfWork, prKey, startWork } from './works.ts';

/** What the registry, the status source and the ledger say of the live sessions and the agents. */
export interface LiveFacts {
  picked: { source: StatusSource; warning: string | null };
  live: LiveSession[];
  /** each session's status from the status source, by session id */
  known: Map<string, SourceStatus>;
  /** each live session's branch and repo, in the order of `live` */
  branches: (string | null)[];
  repos: (string | null)[];
  agents: LedgerAgent[];
  beats: Map<string, BoardBeat>;
}

/** Reads the registry's live sessions, their statuses, branches and repos, and the ledger's agents. */
export async function readLive(ctx: BuildContext): Promise<LiveFacts> {
  const { settings, now, nowMs } = ctx;
  const picked = ctx.sourceOverride
    ? { source: ctx.sourceOverride, warning: null }
    : pickSource(settings.statusSource, settings.it2Path);
  const live = await liveSessions(settings.sessionsDir);
  const [known, branches, repos] = await Promise.all([
    picked.source.statuses(live),
    Promise.all(live.map((session) => ctx.lookups.branchOf(session.cwd, nowMs))),
    Promise.all(live.map((session) => ctx.lookups.repoOf(session.cwd))),
  ]);
  const { agents, beats } = readAgents(
    { ledger: settings.ledgerFile, progress: settings.progressFile },
    now,
    settings.ledgerTimeZone,
  );
  return { picked, live, known, branches, repos, agents, beats };
}

/** What else is known of the live sessions: who listens, the voice session, phone mode, blank sessions, titles and usage. */
export interface SessionFacts {
  /** the live listeners (each a running `once-upon wait`), the process parents `ps` knows, and which session each pid is */
  waits: Listener[];
  parents: Map<number, number>;
  sessionByPid: Map<number, string>;
  /** sessions whose only activity is a listener's wait: shown in the Listeners lane alone */
  quiet: Set<string>;
  voiceFiles: ReturnType<typeof readVoice>;
  phone: BoardData['phone'];
  /** sessions with no prompt yet, at rest: the Blank strip */
  blankIds: Set<string>;
  /** each session's own title from its transcript */
  titles: Map<string, string>;
  statusLines: ReturnType<typeof readStatusLines>;
}

/** The Board's trackers of what a session's transcript says (blank.ts, titles.ts), which keep what they read between builds. */
export interface Trackers {
  blank: BlankSessions;
  titles: SessionTitles;
}

export async function readSessionFacts(
  ctx: BuildContext,
  { live, known, agents }: LiveFacts,
  trackers: Trackers,
): Promise<SessionFacts> {
  const { settings, nowMs } = ctx;
  // a session whose only activity is a listener's wait is shown in the Listeners lane alone, not as a card too
  const waits = listeners(ctx.home, nowMs).filter((wait) => wait.live);
  const parents = waits.length ? await parentMap() : new Map<number, number>();
  const sessionByPid = new Map(live.map((one) => [one.pid, one.session]));
  const quiet = listeningOnly(live, known, waits, parents, sessionByPid, agents);

  // the voice session is pinned above the columns, so it is on no card (its agents keep theirs)
  const voiceFiles = settings.voiceDir ? readVoice(settings.voiceDir, nowMs) : null;
  // the phone buttons need Larmor's checkout to run its voice_ctl; phone mode is the `away` file, the bridge a local port
  const phone: BoardData['phone'] =
    settings.voiceDir && settings.larmorDir && phoneReady(settings.larmorDir)
      ? { on: awayOn(settings.voiceDir), bridge: await bridgeUp(settings.voiceDir, nowMs) }
      : null;

  // sessions with no prompt yet (new, or just cleared) that are at rest and would be cards of their own: the Blank strip
  const blankIds = new Set<string>();
  await Promise.all(
    live.map(async (session) => {
      const status = known.get(session.session)?.status;
      const resting =
        session.status !== 'busy' && (!status || status === 'idle' || status === 'done');
      const voiced = !!voiceFiles && session.session === voiceFiles.session;
      if (
        resting &&
        !voiced &&
        !quiet.has(session.session) &&
        (await trackers.blank.isBlank(settings.projectsDir, session.session, session.cwd, nowMs))
      ) {
        blankIds.add(session.session);
      }
    }),
  );
  trackers.blank.keep(new Set(live.map((session) => session.session)));
  // each session's own title from its transcript, for when the tab's name says nothing (titles.ts)
  const titles = new Map<string, string>();
  await Promise.all(
    live.map(async (session) => {
      const title = await trackers.titles.titleOf(
        settings.projectsDir,
        session.session,
        session.cwd,
        nowMs,
      );
      if (title) {
        titles.set(session.session, title);
      }
    }),
  );
  trackers.titles.keep(new Set(live.map((session) => session.session)));
  // each session's context use and the usage limits, from the status line's copies (statusline.ts)
  const statusLines = readStatusLines(
    ctx.home,
    new Set(live.map((session) => session.session)),
    nowMs,
  );
  return { waits, parents, sessionByPid, quiet, voiceFiles, phone, blankIds, titles, statusLines };
}

/** Where each live session went: the cards of sessions standing alone, and the sessions set aside. */
export interface PlacedSessions {
  /** a session standing alone is a card of its own */
  sessionCards: BoardCard[];
  /** the sessions whose only activity is a listener's wait */
  quietViews: BoardSession[];
  /** the sessions that have had no prompt yet, with their lane */
  blankViews: { lane: string; view: BoardSession }[];
  /** the voice session, pinned above the columns and on no card */
  pin: PinnedVoice | null;
  /** each live session's repo */
  repoBySession: Map<string, string | null>;
  /** when each session entered its status, kept for the next build */
  seen: Map<string, { status: BoardStatus; since: number }>;
}

/**
 * Sorts the live sessions: one on a branch of its own joins that branch's work, the rest are cards of their own.
 * `works` is changed: a session on a branch GitHub has an open PR for starts that work when none has it, a work with a
 * local story takes the PR number (or merge) GitHub reports for its branch, and the session is added to its work's
 * `sessions`. `seen` is what the last build knew of each session's status, and the answer carries what the next needs.
 */
export function placeSessions(
  ctx: BuildContext,
  { live, known, branches, repos, picked }: LiveFacts,
  facts: SessionFacts,
  works: Map<string, Work>,
  seen: Map<string, { status: BoardStatus; since: number }>,
): PlacedSessions {
  const { nowMs } = ctx;
  const { quiet, voiceFiles, blankIds, titles, statusLines } = facts;
  const quietViews: BoardSession[] = [];
  const pin: { found: PinnedVoice | null } = { found: null };
  const blankViews: { lane: string; view: BoardSession }[] = [];
  // sessions: one on a branch of its own joins that branch's work, the rest are cards of their own
  const sessionCards: BoardCard[] = [];
  const repoBySession = new Map<string, string | null>();
  const next = new Map<string, { status: BoardStatus; since: number }>();
  live.forEach((session, index) => {
    const extra = known.get(session.session);
    const status: BoardStatus = extra?.status || (session.status === 'busy' ? 'working' : 'idle');
    const tracked = next.get(session.session) ?? seen.get(session.session);
    let since = session.statusAt || session.startedAt || nowMs;
    if (tracked) {
      since = tracked.status === status ? tracked.since : nowMs;
    }
    next.set(session.session, { status, since });
    const repo = repos[index];
    repoBySession.set(session.session, repo);
    const branch = branches[index];
    const view: SessionView = {
      card: {
        id: session.session,
        title:
          extra?.title || titles.get(session.session) || session.name || path.basename(session.cwd),
        cwd: session.cwd,
        branch,
        status,
        detail: extra?.detail || null,
        since: new Date(since).toISOString(),
        source: extra ? (picked.source.name as 'iterm' | 'registry') : 'registry',
        focus: picked.source.name === 'iterm' && !!extra,
        context: statusLines.context.get(session.session) ?? null,
        rested_at:
          session.status !== 'busy' && session.statusAt
            ? new Date(session.statusAt).toISOString()
            : null,
      },
    };
    if (quiet.has(session.session) && !(voiceFiles && session.session === voiceFiles.session)) {
      quietViews.push(view.card);
      return;
    }
    if (voiceFiles && session.session === voiceFiles.session) {
      pin.found = {
        view: view.card,
        lane: laneOf(session.cwd, repo),
        repo,
        busy: session.status === 'busy',
      };
      return;
    }
    // a session standing alone is a card of its own, unless it has had no prompt yet: then it is a chip in the Blank strip
    const alone = () => {
      if (blankIds.has(session.session)) {
        blankViews.push({ lane: laneOf(session.cwd, repo), view: view.card });
      } else {
        sessionCards.push(sessionCard(session, view, repo));
      }
    };
    if (!repo || !branch || DEFAULT_BRANCHES.has(branch)) {
      alone();
      return;
    }
    // sessions share a card only on the same live branch, one that has a PR still open or a story; otherwise the session
    // is a card of its own, titled by the session (a branch whose PR merged or closed, or that has no PR, is no unit of work)
    const isOpen = (candidate: Work) =>
      !candidate.mergedAt &&
      (!candidate.number ||
        !candidate.repo ||
        (ctx.review.info(candidate.repo, candidate.number)?.state ?? 'open') === 'open');
    let work = [...works.values()].find(
      (candidate) =>
        candidate.repo &&
        sameRepo(candidate.repo, repo) &&
        branchOfWork(ctx.review, candidate) === branch &&
        isOpen(candidate) &&
        (candidate.number || candidate.story || candidate.local),
    );
    if (!work) {
      const found = ctx.review.branchPr(repo, branch);
      ctx.review.kickBranch(repo, branch, session.cwd);
      if (found && found.state === 'open') {
        const key = prKey(repo, found.number);
        if (!works.has(key)) {
          startWork(works, {
            key,
            repo,
            number: found.number,
            branch,
            story: null,
            mergedAt: null,
            title: null,
            built: false,
          });
        }
        work = works.get(key);
      }
    }
    if (work && !work.number && work.local) {
      // a branch with a local story and no PR yet, until GitHub says it has one
      const found = ctx.review.branchPr(repo, branch);
      ctx.review.kickBranch(repo, branch, session.cwd);
      if (found && found.state === 'open' && !works.has(prKey(repo, found.number))) {
        work.number = found.number;
      } else if (found?.state === 'merged') {
        // the branch's PR merged: its local story is done, so a session still on the branch is a card of its own
        work.number = found.number;
        work.mergedAt = found.merged_at;
      }
    }
    if (work && isOpen(work)) {
      work.sessions.push(view);
    } else {
      alone();
    }
  });
  return { sessionCards, quietViews, blankViews, pin: pin.found, repoBySession, seen: next };
}
