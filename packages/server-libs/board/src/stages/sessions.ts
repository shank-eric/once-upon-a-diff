/**
 * The live sessions: what the registry, the status source and the transcripts say of them, and which card
 * each goes on. A session on a branch of its own, or whose runs name a card on one, joins that branch's work (works.ts); a
 * session standing alone is a card of its own (cards.ts); the voice session is pinned above the columns; an editor's session is in
 * the editors strip alone; a session that only listens is shown in the Listeners lane; one with no prompt yet is a chip in the Blank strip.
 */
import { prWorkKey } from '@once-upon-a-diff/terms/ids';
import path from 'node:path';
import { sameRepo } from '@once-upon-a-diff/foundation/repos';
import { isFeatureBranch } from '@once-upon-a-diff/foundation/settings';
import { readAgents } from '@once-upon-a-diff/state/records/agents/read';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import type { BacklogItem } from '@once-upon-a-diff/state/queues/backlog/types';
import type { BlankSessions } from '@once-upon-a-diff/adapters/claude-sessions/blank-sessions';
import type { SubagentLiveness } from '@once-upon-a-diff/adapters/claude-sessions/subagent-liveness';
import type { SessionTitles } from '@once-upon-a-diff/adapters/claude-sessions/titles';
import { readStatusLines } from '@once-upon-a-diff/adapters/claude-sessions/statusline';
import { phoneReady, readVoice, voiceState } from '@once-upon-a-diff/adapters/larmor';
import {
  Listening,
  adoptHandlers,
  listeningOnly,
  parentMap,
  type Listener,
} from '@once-upon-a-diff/core/features/listeners/service';
import { pickSource } from '@once-upon-a-diff/core/features/sessions/sources';
import { type SourceStatus, type StatusSource } from '@once-upon-a-diff/adapters/status-source';
import { type LiveSession } from '@once-upon-a-diff/adapters/claude-sessions/live-sessions';
import type {
  BoardCard,
  BoardData,
  BoardSession,
  BoardStatus,
} from '@once-upon-a-diff/contracts/types';
import { sessionCard } from './cards.ts';
import { laneOf } from './lanes.ts';
import {
  liveRegistry,
  registryNotice,
} from '@once-upon-a-diff/adapters/claude-sessions/live-sessions';
import type { BuildContext, PinnedVoice, SessionView, Work } from './types.ts';
import { branchOfWork, startWork } from './works.ts';
import {
  endGoneSelfRuns,
  openSessions,
  selfSessions,
  sessionHomes,
  type SessionHome,
} from './self-runs.ts';
import { endDeadRuns, runsToJudge } from './dead-runs.ts';
import { liveEditors } from './editors.ts';
import { launchedBy, type Launched } from './dispatching.ts';

/** What the registry and the status source say of the live sessions and the agents. */
export interface LiveFacts {
  picked: { source: StatusSource; warning: string | null };
  live: LiveSession[];
  /** each session's status from the status source, by session id */
  known: Map<string, SourceStatus>;
  /** each live session's branch and repo, in the order of `live` */
  branches: (string | null)[];
  repos: (string | null)[];
  agents: LedgerAgent[];
  /** the registered editors, not among the agents */
  editors: LedgerAgent[];
  /** the scan is sound: the registry folder read, and no file it could not use whose pid runs (a session may be missing from `live`) */
  trusted: boolean;
}

/** Reads the registry's live sessions, their statuses, branches and repos, and the registered agents. */
export async function readLive(ctx: BuildContext, liveness: SubagentLiveness): Promise<LiveFacts> {
  const { settings, nowMs } = ctx;
  const status: { source: StatusSource; warning: string | null } = ctx.sourceOverride
    ? { source: ctx.sourceOverride, warning: null }
    : pickSource(settings.it2Path, ctx.home);
  const { sessions: live, health, unknown } = await liveRegistry(settings.sessionsDir);
  // the board's one warning line also says when Claude Code's session files are there and none could be used
  const picked = {
    source: status.source,
    warning: [status.warning, registryNotice(health)].filter(Boolean).join(' ') || null,
  };
  const [known, branches, repos] = await Promise.all([
    picked.source.statuses(live),
    Promise.all(live.map((session) => ctx.lookups.branchOf(session.cwd, nowMs))),
    Promise.all(live.map((session) => ctx.lookups.repoOf(session.cwd))),
  ]);
  const { agents: registered, editors } = readAgents(ctx.home);
  // a self run of a session that is gone is shown stopped (self-runs.ts); an unusable registry scan changes nothing, and
  // neither does one with a file it could not use whose pid runs (its session may be that one: unknown, not gone)
  const trusted = health.folder === 'ok' && !unknown;
  const gone = trusted
    ? endGoneSelfRuns(
        registered,
        live.map((session) => session.session.slice(0, 8)),
      )
    : registered;
  // a work run whose subagent transcript has been silent for QUIET_MS is shown dead (dead-runs.ts); no transcript found, no change
  const agents = endDeadRuns(
    gone,
    await liveness.lastWrite(settings.projectsDir, runsToJudge(gone), nowMs),
    nowMs,
  );
  return { picked, live, known, branches, repos, agents, editors, trusted };
}

/** What else is known of the live sessions: who listens, the voice session, phone mode, blank sessions, titles and usage. */
export interface SessionFacts {
  /** the live listeners (each a running `once-upon wait`), the process parents `ps` knows, and which session each pid is */
  waits: Listener[];
  parents: Map<number, number>;
  sessionByPid: Map<number, string>;
  /** sessions that listen: shown in the Listeners lane alone, each with whether it is busy there */
  quiet: Map<string, boolean>;
  voiceFiles: ReturnType<typeof readVoice>;
  phone: BoardData['phone'];
  /** the sessions Start voice may type into (same gate as `phone`) */
  voiceStart: BoardData['voice_start'];
  voicePaused: boolean;
  /** sessions with no prompt yet, at rest: the Blank strip */
  blankIds: Set<string>;
  /** each session's own title from its transcript */
  titles: Map<string, string>;
  statusLines: ReturnType<typeof readStatusLines>;
}

/** The Board's trackers of what a session's transcript says (blank-sessions.ts, titles.ts), which keep what they read between builds. */
export interface Trackers {
  blank: BlankSessions;
  titles: SessionTitles;
  /** the session each listener's wait ran in ({consumer: session}), for the handling beat its wait leaves behind */
  listenerSessions: Map<string, string>;
}

export async function readSessionFacts(
  ctx: BuildContext,
  { live, known, agents }: LiveFacts,
  trackers: Trackers,
): Promise<SessionFacts> {
  const { settings, nowMs } = ctx;
  // a session that listens is shown in the Listeners lane alone, not as a card too (busy or not)
  const waits = new Listening(ctx.home).live(nowMs);
  const parents = waits.length ? await parentMap() : new Map<number, number>();
  const sessionByPid = new Map(live.map((one) => [one.pid, one.session]));
  adoptHandlers(waits, live, parents, sessionByPid, trackers.listenerSessions);
  const quiet = listeningOnly(live, known, waits, parents, sessionByPid, agents);

  // the voice session is pinned above the columns, so it is on no card (its agents keep theirs)
  // voice, pause, phone mode and the bridge all come from one `voice_ctl status`; null when Larmor cannot say, shown as off
  const larmor = settings.larmorDir ? await voiceState(settings.larmorDir) : null;
  const voiceFiles = readVoice(larmor, nowMs);
  // the phone buttons need Larmor's checkout to run its voice_ctl, and its answer
  const phone: BoardData['phone'] =
    larmor && settings.larmorDir && phoneReady(settings.larmorDir)
      ? { on: larmor.away, bridge: larmor.bridge }
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
  // Start voice: the last voice session if it is still live, and each live session with whether it is at its prompt
  let voiceStart: BoardData['voice_start'] = null;
  if (phone) {
    const candidates = live
      .filter((session) => !session.kind || session.kind === 'interactive')
      .map((session) => {
        const status = known.get(session.session)?.status;
        return {
          id: session.session,
          name: titles.get(session.session) || session.name || path.basename(session.cwd),
          idle: session.status !== 'busy' && (!status || status === 'idle' || status === 'done'),
        };
      });
    const last = larmor?.lastVoice;
    const lastLive = last ? candidates.find((one) => one.id === last.session) : undefined;
    voiceStart = { last: lastLive ? { id: lastLive.id, name: lastLive.name } : null, candidates };
  }
  return {
    waits,
    parents,
    sessionByPid,
    quiet,
    voiceFiles,
    phone,
    voiceStart,
    voicePaused: !!larmor?.paused,
    blankIds,
    titles,
    statusLines,
  };
}

/**
 * What the board remembers of a session between builds: its status and since when, whether its last working build had it
 * Thinking (`thought`), and when it went idle after that (`restedAt`, ms): it is in Research until the finished-agent timer
 * runs out. Memory only, so a restart forgets it and the session just goes quiet.
 */
export interface SeenSession {
  status: BoardStatus;
  since: number;
  thought: boolean;
  restedAt: number | null;
}

/** A session that is a card or on a work, with what the card keeper (learned.ts) needs to give it a stored card. */
export interface SessionLearned {
  session: string;
  title: string;
  cwd: string;
  repo: string | null;
  /** whether the repo lookup answered in time (false: it is the last known one) */
  repoAnswered: boolean;
  branch: string | null;
  /** the work it is on, null when it stands alone */
  workKey: string | null;
  /** it has a run of its own open: its agent card is the card */
  hasRun: boolean;
}

/** Where each live session went: the cards of sessions standing alone, and the sessions set aside. */
export interface PlacedSessions {
  /** a session standing alone is a card of its own */
  sessionCards: BoardCard[];
  /** the sessions that listen */
  quietViews: BoardSession[];
  /** the sessions that have had no prompt yet, with their lane */
  blankViews: { lane: string; view: BoardSession }[];
  /** an editor's session, in the editors strip and on no card: the parent its other agents (a critic, a helper) are "from" */
  editorViews: { lane: string; view: BoardSession }[];
  /** the voice session, pinned above the columns and on no card */
  pin: PinnedVoice | null;
  /** each live session's repo */
  repoBySession: Map<string, string | null>;
  /** when each session entered its status, kept for the next build */
  seen: Map<string, SeenSession>;
  /** the agents each session launched, by the first 8 of its id (dispatching.ts) */
  launched: Map<string, Launched>;
  /** the sessions that ended as a card or on a work (not an editor, a listener, the voice session or a blank one) */
  learned: SessionLearned[];
}

/** What one build's sorting of the live sessions shares: its facts, what it remembers and where each session went. */
interface Sorting {
  ctx: BuildContext;
  live: LiveFacts;
  facts: SessionFacts;
  works: Map<string, Work>;
  seen: Map<string, SeenSession>;
  researchMs: number;
  own: ReturnType<typeof selfSessions>;
  withRun: Set<string>;
  launched: Map<string, Launched>;
  homes: Map<string, SessionHome>;
  editorSessions: Set<string | null | undefined>;
  quietViews: BoardSession[];
  pin: { found: PinnedVoice | null };
  blankViews: { lane: string; view: BoardSession }[];
  editorViews: { lane: string; view: BoardSession }[];
  sessionCards: BoardCard[];
  joinedCards: Set<BoardCard>;
  repoBySession: Map<string, string | null>;
  next: Map<string, SeenSession>;
  learned: SessionLearned[];
}

/** One live session as it is placed. */
interface One {
  session: LiveSession;
  view: SessionView;
  entry: SeenSession;
  tracked: SeenSession | undefined;
  restedAt: number | null;
  status: BoardStatus;
  repo: string | null;
  branch: string | null;
}

/** A session's status and since when, against what the last build knew of it, and when it went to rest. */
function trackSession(
  sort: Sorting,
  session: LiveSession,
): {
  status: BoardStatus;
  tracked: SeenSession | undefined;
  entry: SeenSession;
  restedAt: number | null;
} {
  const { nowMs } = sort.ctx;
  const extra = sort.live.known.get(session.session);
  const status: BoardStatus = extra?.status || (session.status === 'busy' ? 'working' : 'idle');
  const tracked = sort.next.get(session.session) ?? sort.seen.get(session.session);
  let since = session.statusAt || session.startedAt || nowMs;
  if (tracked) {
    since = tracked.status === status ? tracked.since : nowMs;
  }
  // a session that was Thinking and is now at rest is in Research until the timer a finished research agent has runs out
  const resting = status === 'idle' || status === 'done';
  const finishedThinking = !!tracked?.thought;
  let restedAt = null as number | null;
  if (resting && session.status !== 'busy') {
    restedAt = finishedThinking ? (session.statusAt ?? nowMs) : (tracked?.restedAt ?? null);
  }
  const entry: SeenSession = { status, since, thought: false, restedAt };
  sort.next.set(session.session, entry);
  return { status, tracked, entry, restedAt };
}

/** A registered session with no run open sits on no work's card: its runs say where its work is. */
function isStray(sort: Sorting, session: LiveSession): boolean {
  const sid = session.session.slice(0, 8);
  return sort.own.registered.has(sid) && !sort.own.open.has(sid);
}

/** The session's card view, with the lines the status source and the status lines have for it. */
function viewOf(
  sort: Sorting,
  session: LiveSession,
  status: BoardStatus,
  branch: string | null,
): SessionView {
  const extra = sort.live.known.get(session.session);
  const since = sort.next.get(session.session)?.since ?? Date.now();
  return {
    card: {
      id: session.session,
      title: sort.facts.titles.get(session.session) || session.name || path.basename(session.cwd),
      cwd: session.cwd,
      branch,
      status,
      detail: extra?.detail || null,
      since: new Date(since).toISOString(),
      source: 'registry',
      // a session can be raised only when iTerm knows its tab (a session in another terminal has none)
      focus: extra?.tab === true,
      context: sort.facts.statusLines.context.get(session.session) ?? null,
      rested_at:
        session.status !== 'busy' && session.statusAt
          ? new Date(session.statusAt).toISOString()
          : null,
      ...(sort.live.trusted && status === 'working' && isStray(sort, session)
        ? { thinking: true as const }
        : {}),
    },
  };
}

/** Sets the session aside when it is an editor's, one that listens, or the voice session: true when it is on no card. */
function setAside(sort: Sorting, one: One): boolean {
  const { session, view, repo } = one;
  const voiceFiles = sort.facts.voiceFiles;
  const voiced = !!voiceFiles && session.session === voiceFiles.session;
  if (sort.editorSessions.has(session.session) && !voiced) {
    sort.editorViews.push({ lane: laneOf(session.cwd, repo), view: view.card });
    return true;
  }
  if (sort.facts.quiet.has(session.session) && !voiced) {
    sort.quietViews.push(view.card);
    return true;
  }
  if (voiced) {
    sort.pin.found = {
      view: view.card,
      lane: laneOf(session.cwd, repo),
      repo,
      busy: session.status === 'busy',
    };
    return true;
  }
  return false;
}

/** Records a session that ended as a card or on a work, with what the card keeper (learned.ts) needs. */
function learn(
  sort: Sorting,
  { session, view }: One,
  repo: string | null,
  branch: string | null,
  workKey: string | null,
): void {
  sort.learned.push({
    session: session.session,
    title: view.card.title,
    cwd: session.cwd,
    repo,
    repoAnswered: sort.ctx.lookups.repoAnswered(session.cwd),
    branch,
    workKey,
    hasRun: sort.withRun.has(session.session.slice(0, 8)),
  });
}

/** A session at rest after thinking is in Research until the finished-agent timer runs out, unless it has runs of its own. */
function isResearching(sort: Sorting, { session, restedAt }: One): boolean {
  const sid = session.session.slice(0, 8);
  const rested = restedAt !== null && restedAt + sort.researchMs > sort.ctx.nowMs;
  return sort.live.trusted && rested && !sort.withRun.has(sid) && !sort.launched.has(sid);
}

/** A session standing alone is a card of its own, unless it has had no prompt yet: then it is a chip in the Blank strip. */
function placeAlone(
  sort: Sorting,
  one: One,
  placed: { repo: string | null; branch: string } | undefined,
  placeRepo: string | null,
  placeBranch: string | null,
): void {
  const { session, view, entry, tracked, status, repo } = one;
  const sid = session.session.slice(0, 8);
  if (sort.live.trusted && status === 'working' && !sort.withRun.has(sid)) {
    view.card.thinking = true;
  }
  // `thought` outlives a build that sees the session not working (a tab status ahead of the registry, an untrusted scan)
  // until the session is at rest, so the move to Research is not lost to one such build
  entry.thought = !!view.card.thinking || (session.status === 'busy' && !!tracked?.thought);
  if (isResearching(sort, one)) {
    view.card.researched = true;
  }
  if (sort.facts.blankIds.has(session.session)) {
    sort.blankViews.push({ lane: laneOf(session.cwd, repo), view: view.card });
    return;
  }
  const made = sessionCard(session, view, repo, placed);
  // a session joined to a card whose branch has no work, and another session checked out on that branch, are one card
  const same = sort.sessionCards.find(
    (card) =>
      (placed || sort.joinedCards.has(card)) &&
      card.branch === made.branch &&
      sameRepo(card.repo, made.repo),
  );
  if (same) {
    same.sessions.push(view.card);
  } else {
    sort.sessionCards.push(made);
    if (placed) {
      sort.joinedCards.add(made);
    }
  }
  learn(sort, one, placeRepo, placeBranch, null);
}

/** Whether a work is still open: not merged, and (when GitHub has said) its PR open. */
function isOpenWork(ctx: BuildContext, candidate: Work): boolean {
  return (
    !candidate.mergedAt &&
    (!candidate.number ||
      !candidate.repo ||
      (ctx.review.info(candidate.repo, candidate.number)?.state ?? 'open') === 'open')
  );
}

/**
 * The work a session on this branch joins: one that has the branch, else one a PR GitHub has open for the branch starts.
 * A work with a local story and no PR takes the PR number (or merge) GitHub reports, once it does.
 */
function workForBranch(
  sort: Sorting,
  session: LiveSession,
  where: { repo: string; branch: string; kickable: boolean },
): Work | undefined {
  const { ctx, works } = sort;
  const { repo: placeRepo, branch: placeBranch } = where;
  // GitHub is asked from the session's own folder, so only for a branch of the repo it is in
  const kick = () => {
    if (where.kickable) {
      ctx.review.kickBranch(placeRepo, placeBranch, session.cwd, ctx.nowMs);
    }
  };
  let work = [...works.values()].find(
    (candidate) =>
      candidate.repo &&
      sameRepo(candidate.repo, placeRepo) &&
      branchOfWork(ctx.review, candidate) === placeBranch &&
      isOpenWork(ctx, candidate) &&
      (candidate.number || candidate.story || candidate.local),
  );
  if (!work) {
    const found = ctx.review.branchPr(placeRepo, placeBranch);
    kick();
    if (found && found.state === 'open') {
      const key = prWorkKey(placeRepo, found.number);
      if (!works.has(key)) {
        startWork(works, {
          key,
          repo: placeRepo,
          number: found.number,
          branch: placeBranch,
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
    const found = ctx.review.branchPr(placeRepo, placeBranch);
    kick();
    if (found && found.state === 'open' && !works.has(prWorkKey(placeRepo, found.number))) {
      work.number = found.number;
    } else if (found?.state === 'merged') {
      // the branch's PR merged: its local story is done, so a session still on the branch is a card of its own
      work.number = found.number;
      work.mergedAt = found.merged_at;
    }
  }
  return work;
}

/** Places one live session: set aside, on its branch's work, or a card of its own. */
function placeOne(sort: Sorting, session: LiveSession, index: number): void {
  const { live } = sort;
  const { status, tracked, entry, restedAt } = trackSession(sort, session);
  const repo = live.repos[index];
  sort.repoBySession.set(session.session, repo);
  const branch = live.branches[index];
  const one: One = {
    session,
    view: viewOf(sort, session, status, branch),
    entry,
    tracked,
    restedAt,
    status,
    repo,
    branch,
  };
  if (setAside(sort, one)) {
    return;
  }
  // the card its runs name puts it on that card's branch, not its checkout's
  const joined: SessionHome | undefined = sort.homes.get(session.session.slice(0, 8));
  const placeRepo = joined ? (joined.repo ?? repo) : repo;
  const placeBranch = joined ? joined.branch : branch;
  const placed = joined && { repo: placeRepo, branch: joined.branch };
  // a registered session with no run open sits on no work's card: its runs say where its work is (unless a recent run names one)
  const stray = !joined && isStray(sort, session);
  if (!placeRepo || !isFeatureBranch(placeBranch) || stray) {
    placeAlone(sort, one, placed, placeRepo, placeBranch);
    return;
  }
  // sessions share a card only on the same live branch, one that has a PR still open or a story; otherwise the session
  // is a card of its own, titled by the session (a branch whose PR merged or closed, or that has no PR, is no unit of work)
  const work = workForBranch(sort, session, {
    repo: placeRepo,
    branch: placeBranch,
    kickable: !joined || sameRepo(placeRepo, repo),
  });
  if (work && isOpenWork(sort.ctx, work)) {
    // thinking marks a session card of its own (a work's column would read it as Thinking)
    delete one.view.card.thinking;
    work.sessions.push(one.view);
    learn(sort, one, placeRepo, placeBranch, work.key);
    return;
  }
  placeAlone(sort, one, placed, placeRepo, placeBranch);
}

/**
 * Sorts the live sessions: one on a branch of its own joins that branch's work, the rest are cards of their own. A session
 * whose runs name a card (open ones, else the latest within the finished-run wait) goes where that card's branch is instead
 * of where its own checkout is (`sessionHomes`), which is how a session in a main checkout joins the work it launched agents on.
 * `works` is changed: a session on a branch GitHub has an open PR for starts that work when none has it, a work with a
 * local story takes the PR number (or merge) GitHub reports for its branch, and the session is added to its work's
 * `sessions`. `seen` is what the last build knew of each session's status, and the answer carries what the next needs.
 */
export function placeSessions(
  ctx: BuildContext,
  live: LiveFacts,
  facts: SessionFacts,
  works: Map<string, Work>,
  seen: Map<string, SeenSession>,
  items: BacklogItem[],
): PlacedSessions {
  const { nowMs } = ctx;
  const researchMs = ctx.settings.finishedWaitMinutes * 60 * 1000;
  const { agents, trusted } = live;
  const sort: Sorting = {
    ctx,
    live,
    facts,
    works,
    seen,
    researchMs,
    // a session that has registered a run of its own (`agent start --self`) is not guessed onto a branch's card; with no run
    // open it is a card of its own, Thinking while it is busy. Any busy session with no run open under its id is Thinking too,
    // when it would be a card of its own anyway (self-runs.ts); one on a work card stays there. Both only on a sound scan.
    own: selfSessions(agents),
    withRun: openSessions(agents),
    // a session that launched agents is never in Research: its agents are its work, and its card is Working while one runs
    launched: launchedBy(agents, nowMs),
    // where each session's runs say its work is, computed once; an unsound scan changes nothing
    homes: trusted ? sessionHomes(agents, items, nowMs, researchMs) : new Map(),
    // an editor's own session is in the editors strip, busy or not: never a card or a listener
    editorSessions: new Set(liveEditors(live.editors, live.live).map((editor) => editor.session)),
    quietViews: [],
    pin: { found: null },
    blankViews: [],
    editorViews: [],
    sessionCards: [],
    joinedCards: new Set(),
    repoBySession: new Map(),
    next: new Map(),
    learned: [],
  };
  live.live.forEach((session, index) => placeOne(sort, session, index));
  return {
    sessionCards: sort.sessionCards,
    quietViews: sort.quietViews,
    blankViews: sort.blankViews,
    editorViews: sort.editorViews,
    pin: sort.pin.found,
    repoBySession: sort.repoBySession,
    seen: sort.next,
    launched: sort.launched,
    learned: sort.learned,
  };
}
