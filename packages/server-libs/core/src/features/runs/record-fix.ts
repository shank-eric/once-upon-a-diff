/*
 * A fix made outside any run, recorded as one: whoever fixes a request in place (a listener editing the checkout) or whoever sees
 * a branch that moved with no run behind it (the board's Record as fix) ends up with a done fixer run on the branch's card whose
 * commit is the fix. The board reads only runs, so this is what takes the card out of "changed outside a run". `once-upon fixed
 * --sha` calls it, so a listener cannot skip it.
 *
 * Nothing is recorded when a run already accounts for the tip (`coveringRun`: the author or the editor's fixer still going, or a
 * finished one whose commit is it): that run is the answer. The caller carries an approval with `carryApproval` on the finished
 * run, as `agent finish` does (core's features never import each other).
 */
import { commitOf, commitTime, isAncestor } from '@once-upon-a-diff/adapters/git';
import { BACKLOG_NOTE_MAX } from '@once-upon-a-diff/terms/text';
import { newImplicitCardId } from '@once-upon-a-diff/foundation/ids';
import { BacklogStore, cardLookup } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { ensureCard, findCard } from '@once-upon-a-diff/state/queues/backlog/ensure';
import {
  coveringRun,
  isWorkRun,
  runsOf,
  runsOnBranch,
} from '@once-upon-a-diff/state/queues/backlog/phase';
import { implicitTitle } from '@once-upon-a-diff/state/records/agents/implicit';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import { flat } from './checkout.ts';
import { finishRun } from './finish-run.ts';
import { runRegistry } from './registry.ts';
import { legacyCard, startRun, type RunIo } from './start-run.ts';

export interface RecordFixInput {
  repo: string;
  branch: string;
  /** the fixing commit: at or behind HEAD of `checkout` (a sha that is not is refused) */
  sha: string;
  /** the checkout the fix is in; where the run says it worked, and where the sha is checked. Null (a PR story's request): the caller's folder, and the sha is not checked */
  checkout: string | null;
  /** when the fix began (a request's claim); absent, the commit's own time */
  since?: string | null;
  /** one line: what was fixed */
  task: string;
  /** the run's session: the caller's own (first 8 of it), else the card's latest work run's */
  sid?: string | null;
  session?: string | null;
  by?: string | null;
}

export interface RecordedFix {
  /** the run that accounts for the commit: the one recorded, or the one that already did (`covered`) */
  run: string | null;
  card: string | null;
  covered: boolean;
  /** the branch had no open card, so an implicit one was made for the run */
  madeCard: boolean;
  /** the run just recorded and finished: what `carryApproval` reads. Absent when `covered` */
  finished?: LedgerAgent;
}

export async function recordFix(
  home: string,
  input: RecordFixInput,
  options: RunIo & { now?: number } = {},
): Promise<RecordedFix> {
  const { repo, branch } = input;
  const nowMs = options.now ?? Date.now();
  const dir = input.checkout ?? process.cwd();
  // git is the truth for the commit: a typo must not record a wrong tip. Only a named checkout is checked (a PR story's fix has
  // none: the caller's folder is not known to hold it), and one that is gone or no repo is not checked either
  const full = input.checkout ? commitOf(dir, input.sha) : null;
  if (input.checkout && commitOf(dir, 'HEAD') && (!full || !isAncestor(dir, full, 'HEAD'))) {
    throw new Error(`${input.sha} is not a commit at or behind HEAD in ${dir}`);
  }
  const sha = full ?? input.sha;
  const registry = runRegistry(home, options.mirror);
  const agents = registry.agents();
  const onBranch = runsOnBranch(agents, repo, branch);
  const covering = coveringRun(onBranch, sha, nowMs);
  const store = new BacklogStore(home);
  const open = findCard(store.items(), { source: 'agent', repo, branch });
  const legacy = open ? undefined : legacyCard(registry, store, repo, branch, nowMs);
  if (covering) {
    return {
      run: covering.run ?? null,
      card: covering.card ?? open?.id ?? legacy?.id ?? null,
      covered: true,
      madeCard: false,
    };
  }
  let card = open?.id ?? legacy?.id ?? null;
  let madeCard = false;
  if (!card) {
    // a fix is always a run on a card: one is made when the branch has none open (a landed one, or one past the legacy window)
    const title = implicitTitle(input.task) || `fix on ${branch}`;
    card = ensureCard(store, {
      id: newImplicitCardId(),
      source: 'agent',
      title,
      note: input.task !== title ? input.task.slice(0, BACKLOG_NOTE_MAX) : null,
      repo,
      branch,
      worktree: input.checkout,
      by: 'fixed',
      joinBranch: true,
    }).item.id;
    madeCard = true;
  }
  const latestWork = runsOf({ id: card }, agents).filter(isWorkRun).pop();
  const sid = input.sid ?? input.session?.slice(0, 8) ?? latestWork?.sid;
  if (!sid) {
    throw new Error(
      'no session to record the fix under: run it from a Claude session (CLAUDE_CODE_SESSION_ID), or pass --sid SID8',
    );
  }
  const name = `fix-${flat(branch)}`.slice(0, 60);
  // a fixer needs a claimed card; a claim someone holds is never replaced (an author's stays, the fixer starts under it). A card
  // that exists only as runs (a legacy implicit one: no backlog row) has nothing to claim, and the registry reads it as claimed
  const stored = cardLookup(store)(card);
  if (stored && !stored.claimed) {
    store.claim(card, { agent: name, sid, session: input.session, by: 'fixer' });
  }
  // backdated to the work's start so `carryApproval` counts a commit made after it; never before the card's last work run began
  const began = Date.parse(input.since ?? '') || (commitTime(dir, sha)?.getTime() ?? nowMs);
  const startedAt = new Date(
    Math.min(nowMs, Math.max(began, (latestWork?.started?.getTime() ?? 0) + 1000)),
  );
  await startRun(
    home,
    {
      name,
      sid,
      session: input.session,
      role: 'fixer',
      task: input.task,
      card,
      cwd: dir,
      at: startedAt,
      by: input.by,
    },
    options,
  );
  const finished = finishRun(
    home,
    name,
    {
      state: 'done',
      outcome: input.task,
      result: { commit: sha, branch, card },
      sid,
      by: input.by,
    },
    options,
  );
  return { run: finished.run ?? null, card, covered: false, madeCard, finished };
}
