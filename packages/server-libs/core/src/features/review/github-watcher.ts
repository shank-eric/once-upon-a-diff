/**
 * Asks GitHub about each PR story the inbox lists. A PR that has merged is dropped from the inbox (a merged.json in
 * the story's state folder, which prStories skips). So is a PR closed without merging whose head branch is gone
 * (`headRef` is null; for a fork PR that is the fork's branch). Closed with the branch still there stays. Otherwise a story is marked
 * reviewed in the inbox by itself, for one of two reasons the reviewer has already acted on GitHub:
 *
 *   review       the signed-in gh user submitted a review on the PR after the story was built (approved, changes
 *                requested, or commented with a body: a reply in a thread is stored as a COMMENTED review with no body,
 *                so an empty one doesn't count)
 *   all viewed   every file in the PR is marked Viewed on GitHub (what skills/once-upon/bin/viewed.sh reads)
 *
 * It is a read-only GraphQL query through gh (ghEnv drops GITHUB_TOKEN when config.json says so), asked at most once
 * per PR every CACHE_MS, in the background: the inbox list asks for a check and answers at once, and the mark shows
 * on a later poll. There is one check per PR, and its whole answer is kept for the window: the inbox and the board
 * both read it, and it is applied to every listed story for that PR. The same answer carries what the agent board shows
 * about a PR (PrInfo: approvals, merge state, checks, the latest comments by you and by others), and a second small
 * query finds the PR for a branch. The board asks for both in the background as well and reads whatever is kept. A
 * story whose review record has a mark (marked by hand, or unmarked by hand) or an approval is never auto-marked, so a
 * manual unmark sticks. The reason is kept in review.json's mark as `by`.
 *
 * This file is the scheduler: when to ask and what to do with the answers. The asking is in github-checks.ts (with
 * pr-info.ts and merge-rules.ts for what the board shows) and default-branch.ts.
 */
import {
  branchKey,
  branchKeyPrefix,
  prKey,
  prKeyPrefix,
  repoKey,
} from '@once-upon-a-diff/terms/ids';
import { FULL_SHA_RE } from '@once-upon-a-diff/terms/patterns';
import { runGitAsync } from '@once-upon-a-diff/adapters/git';
import { readApproval } from '@once-upon-a-diff/stories/approval';
import type { MarkBy } from '@once-upon-a-diff/stories/review-record';
import { BacklogStore, isListed } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { findCard } from '@once-upon-a-diff/state/queues/backlog/ensure';
import { clearApproval } from './approve.ts';
import { carryRebasedApproval } from './carry-approval.ts';
import { lapseChangesOf } from './lapse-changes.ts';
import { updateReviewRecord } from './review-record.ts';
import { inDefaultBranch } from './default-branch.ts';
import {
  ghBranchCheck,
  ghRequestedCheck,
  whyReviewed,
  type BranchCheck,
  type BranchPr,
  type PrCheck,
  type PrFacts,
  isGone,
  type RequestedCheck,
  type RequestedPr,
} from '@once-upon-a-diff/state/records/github/github-checks';
import { isFeatureBranch } from '@once-upon-a-diff/foundation/settings';
import { markStoryDone, markStoryReviewed, storyHasState, type LocalEntry } from './story-lists.ts';
import type { StoryStore } from '@once-upon-a-diff/stories/store';
import {
  readGithubAnswers,
  writeGithubAnswers,
  type GithubAnswers,
} from '@once-upon-a-diff/adapters/stores/github-answers';
import type { InboxStory, PrInfo, ReviewedBy } from '@once-upon-a-diff/contracts/types';

/** How long one PR's answer (including "nothing yet") is kept before asking GitHub again. */
const CACHE_MS = 3 * 60 * 1000;
/** The longest wait between two asks about a PR or branch whose asks keep failing. */
const MAX_BACKOFF_MS = 30 * 60 * 1000;
/** The least time between two refreshes of the same branch or PR (a burst of pings is one). */
export const REFRESH_GAP_MS = 2000;
/**
 * The least time between two refreshes of the lists (your open PRs): under the 6.5 s between the extension's two pings, so
 * the second one still asks again once GitHub's search has caught up, and a run of pings for different branches can't make
 * a search each.
 */
export const LIST_GAP_MS = 5000;

/** What GitHub said about one PR, when it was asked, and the stories it has been applied to. */
interface Check {
  at: number;
  facts: Promise<PrFacts | null>;
  applied: Set<string>;
}

/** A merged PR whose last commit is the head, or has the head among its commits (GitHub added one since): it shipped that head. */
const mergedWith = (pr: BranchPr, head: string): boolean =>
  pr.state === 'merged' && (pr.head_oid === head || !!pr.shipped?.includes(head));

export class AutoReview {
  /** One check per PR: when it was asked, what it found (null when GitHub couldn't say), and the stories it has been applied to. */
  private checked = new Map<string, Check>();
  private running = new Set<Promise<void>>();
  /** per PR: what GitHub last said and when that answer came (kept across a restart) */
  private known = new Map<string, { at: number; info: PrInfo }>();
  /**
   * per PR or branch: how many asks in a row failed, when the last one did, and whether GitHub said the PR or repo does not
   * exist (never asked again until a ping names it). A success clears it.
   */
  private failures = new Map<string, { n: number; gone: boolean }>();
  /** per branch: how many asks were made (only the newest one's answer is kept, an older ask finishing later is dropped) */
  private branchSeq = new Map<string, number>();
  /** per branch: the newest ask whose answer landed (a failed newest ask leaves an older one's good answer in place) */
  private branchAnswered = new Map<string, number>();
  /**
   * The branches whose answer was loaded from the file and not yet replaced by one from this run: shown on the board as
   * the last known state, but never a reason to write a permanent mark (kickLocal).
   */
  private loadedBranches = new Set<string>();
  /** where the answers are kept (the bridge's home), or undefined for none */
  private home: string | undefined;
  /** what is in the file: the last answer of each kind, by the time it came */
  private kept: GithubAnswers = { branches: {}, prs: {}, requested: null };
  private saveAt = 0;
  private saving = false;
  private branches = new Map<
    string,
    {
      /** when it was asked (the cache's clock, not the answer's age) */
      at: number;
      /** when the answer in `pr` came, undefined when GitHub hasn't answered */
      answeredAt?: number;
      pr: BranchPr | null | undefined;
      heads: string[];
      /** set while `pr` is an older ask's answer: the heads it covered, which `heads` shrinks to if the newest ask fails */
      prHeads?: string[];
      /** the newest ask failed, so an older ask finishing later answers only for its own heads */
      newestFailed?: boolean;
    }
  >();
  /** when each local story's head was last looked for in the default branch (story id and head commit) */
  private delivered = new Map<string, number>();
  private stories: StoryStore;
  private check: PrCheck;
  private checkBranch: BranchCheck;
  private checkRequested: RequestedCheck;
  private asked: { at: number; list: RequestedPr[] } | null = null;
  /** how many asks for the lists were made (only the newest one's answer is kept) */
  private askedSeq = 0;
  /** when each branch or PR was last refreshed, and the lists were */
  private refreshedAt = new Map<string, number>();
  private listRefreshedAt = Number.NEGATIVE_INFINITY;
  private cacheMs: number;

  constructor(
    stories: StoryStore,
    check: PrCheck,
    cacheMs = CACHE_MS,
    checkBranch: BranchCheck = ghBranchCheck,
    checkRequested: RequestedCheck = ghRequestedCheck,
    home?: string,
  ) {
    this.stories = stories;
    this.check = check;
    this.checkBranch = checkBranch;
    this.checkRequested = checkRequested;
    this.cacheMs = cacheMs;
    this.home = home;
    if (home) {
      // what GitHub said before this start: shown until it answers again, and never fresh (at -Infinity asks again at once)
      this.kept = readGithubAnswers(home);
      for (const [key, entry] of Object.entries(this.kept.branches)) {
        this.branches.set(key, {
          at: Number.NEGATIVE_INFINITY,
          answeredAt: entry.at,
          pr: entry.pr,
          heads: [],
        });
        this.loadedBranches.add(key);
      }
      for (const [key, entry] of Object.entries(this.kept.prs)) {
        this.known.set(key, { at: entry.at, info: entry.info });
      }
      if (this.kept.requested) {
        this.asked = { at: Number.NEGATIVE_INFINITY, list: this.kept.requested.list };
      }
    }
  }

  /** Writes what GitHub said, once for the answers that land in the same turn. A home that can't be written loses only the cold start. */
  private save(now: number): void {
    if (!this.home) {
      return;
    }
    this.saveAt = Math.max(this.saveAt, now);
    if (this.saving) {
      return;
    }
    this.saving = true;
    queueMicrotask(() => {
      this.saving = false;
      writeGithubAnswers(this.home as string, this.kept, this.saveAt);
    });
  }

  /** What GitHub last said about a PR, or null when it hasn't answered yet (or the check carries no detail). */
  info(repo: string, number: number): PrInfo | null {
    return this.known.get(prKey(repo, number))?.info || null;
  }

  /** When GitHub last answered about a PR (this run, or the file's): null when it never has. */
  infoAt(repo: string, number: number): number | null {
    return this.known.get(prKey(repo, number))?.at ?? null;
  }

  /** When GitHub last answered about a branch's PR (this run, or the file's): null when it never has. */
  branchAt(repo: string, branch: string): number | null {
    return this.branches.get(branchKey(repo, branch))?.answeredAt ?? null;
  }

  /** How long to wait after the last ask of a PR or branch: the cache time, longer while asks keep failing, forever for one that is gone. */
  private waitFor(key: string): number {
    const failed = this.failures.get(key);
    if (!failed) {
      return this.cacheMs;
    }
    return failed.gone
      ? Number.POSITIVE_INFINITY
      : Math.max(this.cacheMs, Math.min(this.cacheMs * 2 ** failed.n, MAX_BACKOFF_MS));
  }

  private failed(key: string, error: unknown): void {
    const before = this.failures.get(key);
    this.failures.set(key, { n: (before?.n ?? 0) + 1, gone: isGone(error) });
  }

  /** The PR GitHub last said a branch has: null when it has none, undefined when it hasn't answered yet. */
  branchPr(repo: string, branch: string): BranchPr | null | undefined {
    return this.branches.get(branchKey(repo, branch))?.pr;
  }

  /** The open PRs GitHub last said wait on your review or are yours ([] until it first answers). */
  requested(): RequestedPr[] {
    return this.asked?.list || [];
  }

  /** Asks GitHub which open PRs wait on your review or are yours, unless it was asked lately. Doesn't wait. */
  kickRequested(now: number): void {
    if (this.asked && now - this.asked.at < this.cacheMs) {
      return;
    }
    this.asked = { at: now, list: this.asked?.list || [] };
    const seq = ++this.askedSeq;
    const job = this.checkRequested()
      .then((list) => {
        // asks can overlap (a refresh makes one while another is out): only the newest writes
        if (seq === this.askedSeq) {
          this.asked = { at: now, list };
          this.kept.requested = { at: now, list };
          this.save(now);
        }
      })
      .catch(() => undefined)
      .finally(() => this.running.delete(job));
    this.running.add(job);
  }

  /** Asks GitHub which PR a branch has (and, for a merged one, whether `checkout`'s branch contains it), unless it was asked lately. Doesn't wait. */
  kickBranch(
    repo: string,
    branch: string,
    checkout: string,
    now: number,
    heads: string[] = [],
  ): void {
    const key = branchKey(repo, branch);
    const last = this.branches.get(key);
    if (this.failures.has(key) && last && now - last.at < this.waitFor(key)) {
      return;
    }
    // An answer is shared by every caller in its window, but a merged PR is only found for the heads the asker gave (or a
    // branch that has its commits), so a "none" asked without a story's head is not the answer for a caller that has one.
    if (
      last &&
      now - last.at < this.cacheMs &&
      (last.pr?.state === 'open' || heads.every((head) => last.heads.includes(head)))
    ) {
      return;
    }
    // the old answer stays until the new one arrives, and a failed ask keeps it
    const asked =
      last && now - last.at < this.cacheMs ? [...new Set([...last.heads, ...heads])] : heads;
    this.branches.set(key, {
      at: now,
      answeredAt: last?.answeredAt,
      pr: last?.pr,
      heads: asked,
      prHeads: last?.prHeads,
    });
    // Asks can overlap and finish in any order. An answer older than one that already landed is dropped. The newest ask
    // writes whole (its placeholder above covers what it asked, so an older one finishing first must not shrink that and
    // cause another ask). An older ask finishing while the newest is out keeps its PR when it found one, under the
    // placeholder's own time and heads, so that if the newest fails the good answer is still there. A "none" from it asked
    // fewer heads than the newest, so it says nothing for them.
    const seq = (this.branchSeq.get(key) ?? 0) + 1;
    this.branchSeq.set(key, seq);
    const job = this.checkBranch(repo, branch, checkout, asked)
      .then((pr) => {
        if (seq < (this.branchAnswered.get(key) ?? 0)) {
          return;
        }
        if (seq === this.branchSeq.get(key)) {
          this.branches.set(key, { at: now, answeredAt: now, pr, heads: asked });
        } else if (pr) {
          const current = this.branches.get(key);
          this.branches.set(key, {
            at: now,
            answeredAt: now,
            heads: asked,
            ...current,
            pr,
            prHeads: asked,
            ...(current?.newestFailed ? { heads: asked, newestFailed: undefined } : {}),
          });
        } else {
          return;
        }
        this.branchAnswered.set(key, seq);
        this.failures.delete(key);
        this.loadedBranches.delete(key);
        this.kept.branches[key] = { at: now, pr };
        this.save(now);
      })
      .catch((error) => {
        if (seq === this.branchSeq.get(key)) {
          this.failed(key, error);
        }
        // the newest ask failed: an older ask's answer only speaks for the heads that ask had
        const current = this.branches.get(key);
        if (seq === this.branchSeq.get(key) && current) {
          this.branches.set(
            key,
            current.prHeads
              ? { ...current, heads: current.prHeads, prHeads: undefined }
              : { ...current, newestFailed: true },
          );
        }
      })
      .finally(() => this.running.delete(job));
    this.running.add(job);
  }

  /** The PR's check for this window: asked now unless it was asked lately, and kept whole so every caller sees the same answer. */
  private ask(repo: string, number: number, now: number) {
    const key = prKey(repo, number);
    const last = this.checked.get(key);
    if (last && now - last.at < this.waitFor(key)) {
      return last;
    }
    const entry: Check = { at: now, facts: Promise.resolve(null), applied: new Set<string>() };
    entry.facts = this.check(repo, number)
      .then((facts) => {
        // a refresh replaces the entry: an older answer finishing later must not overwrite what the newer one found
        if (facts.info && this.checked.get(key) === entry) {
          this.known.set(key, { at: now, info: facts.info });
          this.kept.prs[key] = { at: now, info: facts.info };
          this.save(now);
        }
        if (this.checked.get(key) === entry) {
          this.failures.delete(key);
        }
        return facts;
      })
      .catch((error) => {
        if (this.checked.get(key) === entry) {
          this.failed(key, error);
        }
        return null;
      });
    this.checked.set(key, entry);
    this.track(entry.facts);
    return entry;
  }

  private track(job: Promise<unknown>): void {
    const tracked = job.then(
      () => undefined,
      () => undefined,
    );
    const done = tracked.finally(() => this.running.delete(done));
    this.running.add(done);
  }

  /** Asks about a PR that has no story in the inbox (the board's), for its details only. Shares the check a story's PR already has. */
  kickInfo(repo: string, number: number, now: number): void {
    this.ask(repo, number, now);
  }

  /**
   * You did something on GitHub (the extension saw it): what GitHub last said about this branch's PR (given by its number, its
   * branch, or both) and the lists of your PRs is stale, so the board's next build asks again. It asks nothing itself, and
   * does nothing (false) for a repo the board follows nothing in (no PR, branch or listed PR of it was asked about): a ping
   * for one costs no rebuild and no search. False also when the same branch or PR was refreshed a moment ago
   * (REFRESH_GAP_MS). The old answers stay until the new ones land. The lists have their own gap (LIST_GAP_MS), so pings for
   * different branches don't each make a search.
   */
  refresh(
    input: { repo: string; branch?: string | null; number?: number | null },
    now = Date.now(),
  ): boolean {
    const { repo, number } = input;
    const branch = input.branch || null;
    if (!this.followsRepo(repo)) {
      return false;
    }
    for (const [key, when] of this.refreshedAt) {
      if (now - when >= REFRESH_GAP_MS) {
        this.refreshedAt.delete(key);
      }
    }
    const gapKey = `${repoKey(repo)}@${branch ?? ''}#${number ?? ''}`;
    if (this.refreshedAt.has(gapKey)) {
      return false;
    }
    this.refreshedAt.set(gapKey, now);
    const named = branch ?? (number ? this.branchOfKnownPr(repo, number) : null);
    const numbers = new Set<number>([
      ...(number ? [number] : []),
      ...(named ? this.markBranchStaleFor(repo, named) : []),
    ]);
    if (number) {
      this.markBranchesOfPrStale(repo, number);
    }
    for (const one of numbers) {
      this.checked.delete(prKey(repo, one));
      this.failures.delete(prKey(repo, one));
    }
    if (this.asked && now - this.listRefreshedAt >= LIST_GAP_MS) {
      this.listRefreshedAt = now;
      this.asked = { ...this.asked, at: 0 };
      // an ask already out started before what you did: its answer must not replace the stale mark
      this.askedSeq++;
    }
    return true;
  }

  /** Whether the board follows anything in a repo: a branch or a PR of it was asked about, or one of its PRs is on a list. */
  private followsRepo(repo: string): boolean {
    const branchPrefix = branchKeyPrefix(repo);
    const prPrefix = prKeyPrefix(repo);
    const lower = repoKey(repo);
    return (
      [...this.branches.keys()].some((key) => key.startsWith(branchPrefix)) ||
      [...this.known.keys(), ...this.checked.keys()].some((key) => key.startsWith(prPrefix)) ||
      !!this.asked?.list.some((pr) => repoKey(pr.repo) === lower)
    );
  }

  /** The branch a PR's last answer said it was on, when the ping named only the PR. */
  private branchOfKnownPr(repo: string, number: number): string | null {
    return this.known.get(prKey(repo, number))?.info.branch ?? null;
  }

  /** Marks a branch's answer stale, and returns the numbers of the PRs on it (the branch's own answer's, and those listed for it). */
  private markBranchStaleFor(repo: string, named: string): number[] {
    const numbers: number[] = [];
    const found = this.branches.get(branchKey(repo, named));
    if (found) {
      this.markBranchStale(branchKey(repo, named), found);
      if (found.pr) {
        numbers.push(found.pr.number);
      }
    }
    for (const [key, { info }] of this.known) {
      if (key.startsWith(prKeyPrefix(repo)) && info.branch === named) {
        numbers.push(info.number);
      }
    }
    return numbers;
  }

  /** A PR the branch check found, whose branch this ping didn't name. */
  private markBranchesOfPrStale(repo: string, number: number): void {
    for (const [key, found] of this.branches) {
      if (key.startsWith(branchKeyPrefix(repo)) && found.pr?.number === number) {
        this.markBranchStale(key, found);
      }
    }
  }

  /** Marks a branch's answer stale. An ask already out started before what you did, so it counts as an older one and can't clear the mark. */
  private markBranchStale(
    key: string,
    found: {
      at: number;
      answeredAt?: number;
      pr: BranchPr | null | undefined;
      heads: string[];
    },
  ): void {
    this.failures.delete(key);
    this.branches.set(key, { ...found, at: 0 });
    this.branchSeq.set(key, (this.branchSeq.get(key) ?? 0) + 1);
  }

  /**
   * A merged story's stored non-listed card lands at the PR's `merged_at`. A listed card is MergeLander's (one writer per
   * card), and a PR closed with its branch deleted is no landing. A failure is swallowed: merged.json is written after it.
   */
  private landStoredCard(
    story: { repo: string; number: number; id: string },
    mergedAt: string | null,
  ) {
    if (!this.home) {
      return;
    }
    try {
      const store = new BacklogStore(this.home);
      const card = findCard(store.items(), {
        source: 'story',
        repo: story.repo,
        pr: story.number,
        story: story.id,
      });
      if (card && !isListed(card)) {
        store.done(card.id, { mergedAt, by: 'merged-pr' });
      }
    } catch {
      // a card that cannot be landed here is landed by the next writer; the inbox drop does not wait for it
    }
  }

  /** Starts a check for each story's PR that wasn't asked about lately, and applies what it found to every listed story of that PR. Doesn't wait. */
  kick(list: InboxStory[], now: number): void {
    for (const story of list) {
      const entry = this.ask(story.repo, story.number, now);
      if (entry.applied.has(story.id)) {
        continue;
      }
      entry.applied.add(story.id);
      this.track(
        entry.facts.then((facts) => {
          if (!facts) {
            return;
          }
          if (facts.merged || facts.abandoned) {
            if (facts.merged) {
              this.landStoredCard(story, facts.info?.merged_at ?? null);
            }
            markStoryDone(
              this.stories,
              story.id,
              facts.merged ? 'merged' : 'closed, branch deleted',
              facts.info?.merged_at ?? null,
            );
            return;
          }
          const why = whyReviewed(facts, story.built_at);
          if (why && !storyHasState(this.stories, story.id)) {
            // a story marked or unmarked by hand, even while GitHub was answering, is left as it is
            markStoryReviewed(this.stories, story.id, true, why);
          }
        }),
      );
    }
  }

  /**
   * Marks the local stories done that are: the branch has a PR on GitHub, open or merged (`pr`), or the story's head is
   * already in the default branch (`delivered`). Asked a few minutes apart per story, never waits, and leaves a story
   * with a mark or an unmark in its review record as it is. The default branch is the checkout's last fetch of
   * origin, which the bridge never refreshes, so `delivered` can lag a fetch. A squash merge shows as a merged PR.
   */
  kickLocal(list: LocalEntry[], now: number): void {
    for (const entry of list) {
      this.kickLocalStory(entry, now);
    }
  }

  private kickLocalStory(entry: LocalEntry, now: number): void {
    const { story } = entry;
    if (entry.approval) {
      this.checkApproval(entry, now);
    }
    // a story you marked or unmarked by hand is left alone, but an approved one still gets the delivered check: pushing
    // it (Push on its page) is what ships it, and its card should clear then
    if (entry.marked && !entry.approval) {
      return;
    }
    const onFeature = story.repo && isFeatureBranch(story.branch);
    if (onFeature && entry.repo_path && this.markedByPr(entry, entry.repo_path, now)) {
      return;
    }
    this.kickDelivered(entry, now, !!onFeature);
  }

  /**
   * Asks about the story's branch's PR and marks the story from it: a PR, open or merged, is done; for an approved story a
   * squash merge leaves the approved head in no branch of the default one, so the merged PR is what shows it shipped (the PR's
   * last commit is the approved head, or the approved head is among its commits: GitHub added one since). An open PR leaves
   * the approval for the card to follow the PR. True when the story was marked.
   */
  private markedByPr(entry: LocalEntry, checkout: string, now: number): boolean {
    const { story, approval } = entry;
    const [repo, branch] = [story.repo as string, story.branch as string];
    this.kickBranch(
      repo,
      branch,
      checkout,
      now,
      [entry.head_oid, approval?.head_oid].filter((oid): oid is string => !!oid),
    );
    // a loaded answer (from before this start) is shown, not acted on: marks are permanent
    const found = this.loadedBranches.has(branchKey(repo, branch))
      ? undefined
      : this.branchPr(repo, branch);
    if (!found) {
      return false;
    }
    if (!approval) {
      this.markLocal(story.id, 'pr', entry.head_oid);
      return true;
    }
    if (!mergedWith(found, approval.head_oid)) {
      return false;
    }
    this.markDelivered(story.id, approval.head_oid, 'pr');
    return true;
  }

  /** Whether an ask for this key was made lately; when it was not, records it (so the next one is). */
  private askedLately(key: string, now: number): boolean {
    const last = this.delivered.get(key);
    if (last !== undefined && now - last < this.cacheMs) {
      return true;
    }
    this.delivered.set(key, now);
    return false;
  }

  /** Asks whether the story's head is in the default branch, which marks it done. `onFeature` stories take the base as it is. */
  private kickDelivered(entry: LocalEntry, now: number, onFeature: boolean): void {
    const { repo_path: checkout, head_oid: head, base_oid: baseOid } = entry;
    const hasNewHead = !!checkout && !!head && head !== baseOid && FULL_SHA_RE.test(head);
    if (!hasNewHead || this.askedLately(`${entry.story.id}@${head}`, now)) {
      return;
    }
    const base = baseOid && FULL_SHA_RE.test(baseOid) ? baseOid : null;
    const job = inDefaultBranch(checkout, head, { rewrittenFrom: onFeature ? null : base })
      .then((yes) => {
        if (yes) {
          this.markDelivered(entry.story.id, head);
        }
      })
      .finally(() => this.running.delete(job));
    this.running.add(job);
  }

  /**
   * An approved story whose branch has moved on is not approved any more: a cached `git rev-parse` of the ref the story
   * follows, and when it names another commit, the approval (and the reviewed mark approving wrote) is cleared. A ref git
   * can't resolve (repo gone, branch deleted) leaves it alone.
   */
  private checkApproval(entry: LocalEntry, now: number): void {
    const { approval, repo_path: checkout, head_ref: ref } = entry;
    if (!approval || !checkout || !ref) {
      return;
    }
    const key = `approval:${entry.story.id}@${approval.head_oid}`;
    if (this.askedLately(key, now)) {
      return;
    }
    const job = runGitAsync(checkout, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      timeout: 10000,
    })
      .then(({ code, stdout }) => {
        const tip = stdout.trim();
        const current = readApproval(this.stories, entry.story.id);
        const stillApproved = !current?.lapsed && current?.head_oid === approval.head_oid;
        if (code === 0 && tip && stillApproved && tip !== approval.head_oid) {
          // a moved tip is looked at again on the next poll until it is carried or lapsed
          this.delivered.delete(key);
          if (!carryRebasedApproval(this.stories, entry, tip, now)) {
            const lapse = lapseChangesOf(this.stories, entry, current, tip, now);
            clearApproval(this.stories, entry.story.id, { lapsed: true, lapse });
          }
        }
      })
      .finally(() => this.running.delete(job));
    this.running.add(job);
  }

  /** Forgets when a story's heads were last looked for in the default branch, so the next kickLocal looks again (after a push). */
  forget(id: string): void {
    for (const key of this.delivered.keys()) {
      if (key.startsWith(`${id}@`) || key.startsWith(`approval:${id}@`)) {
        this.delivered.delete(key);
      }
    }
  }

  /**
   * A local story whose head is in the default branch is done. One approved at that head has shipped, so its approval
   * ends too (the approval cleared, which takes it out of Ready to ship) and its mark becomes `delivered`, or `pr` when a
   * merged PR is what showed it (a squash merge).
   */
  private markDelivered(id: string, head: string, why: MarkBy = 'delivered'): void {
    const shipped = updateReviewRecord(this.stories, id, (record) => {
      if (record.approval?.head_oid !== head) {
        return false;
      }
      delete record.approval;
      record.mark = { at: new Date().toISOString(), by: why, head_oid: head };
      return true;
    });
    if (!shipped) {
      this.markLocal(id, why, head);
    }
  }

  /** Writes a local story's done mark unless a hand mark or unmark got there first. */
  private markLocal(id: string, why: MarkBy, head: string | null): void {
    if (!storyHasState(this.stories, id)) {
      markStoryReviewed(this.stories, id, true, why, head);
    }
  }

  /** Resolves when every check started so far has finished (for tests). */
  async idle(): Promise<void> {
    while (this.running.size) {
      await Promise.all([...this.running]);
    }
  }
}

export type { ReviewedBy };
