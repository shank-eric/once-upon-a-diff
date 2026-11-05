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
 * story whose reviewed.json exists (marked by hand, or unmarked by hand) is never auto-marked, so a
 * manual unmark sticks. The reason is kept in reviewed.json as `by`.
 *
 * This file is the scheduler: when to ask and what to do with the answers. The asking is in github-checks.ts (with
 * pr-info.ts and merge-rules.ts for what the board shows) and default-branch.ts.
 */
import { FULL_SHA_RE } from '@once-upon-a-diff/domain/patterns';
import { runGitAsync } from '../../adapters/git.ts';
import { readApproval } from '../stories/approval.ts';
import { clearApproval } from './approve.ts';
import { inDefaultBranch } from './default-branch.ts';
import {
  ghBranchCheck,
  ghRequestedCheck,
  whyReviewed,
  type BranchCheck,
  type BranchPr,
  type PrCheck,
  type PrFacts,
  type RequestedCheck,
} from './github-checks.ts';
import { DEFAULT_BRANCHES } from '../config/settings.ts';
import { markStoryDone, markStoryReviewed, storyHasState, type LocalEntry } from './story-lists.ts';
import type { StoryStore } from '../stories/store.ts';
import {
  readGithubAnswers,
  writeGithubAnswers,
  type GithubAnswers,
} from '../../adapters/stores/github-answers.ts';
import type { InboxStory, PrInfo, ReviewedBy } from '@once-upon-a-diff/contracts/types';

/** How long one PR's answer (including "nothing yet") is kept before asking GitHub again. */
export const CACHE_MS = 3 * 60 * 1000;
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

const keyOf = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
const branchKey = (repo: string, branch: string) => `${repo.toLowerCase()}@${branch}`;

export class AutoReview {
  /** One check per PR: when it was asked, what it found (null when GitHub couldn't say), and the stories it has been applied to. */
  private checked = new Map<string, Check>();
  private running = new Set<Promise<void>>();
  private known = new Map<string, PrInfo>();
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
      at: number;
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
  private asked: { at: number; list: { repo: string; number: number }[] } | null = null;
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
        this.branches.set(key, { at: Number.NEGATIVE_INFINITY, pr: entry.pr, heads: [] });
        this.loadedBranches.add(key);
      }
      for (const [key, entry] of Object.entries(this.kept.prs)) {
        this.known.set(key, entry.info);
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
    return this.known.get(keyOf(repo, number)) || null;
  }

  /** The PR GitHub last said a branch has: null when it has none, undefined when it hasn't answered yet. */
  branchPr(repo: string, branch: string): BranchPr | null | undefined {
    return this.branches.get(branchKey(repo, branch))?.pr;
  }

  /** The open PRs GitHub last said wait on your review or are yours ([] until it first answers). */
  requested(): { repo: string; number: number }[] {
    return this.asked?.list || [];
  }

  /** Asks GitHub which open PRs wait on your review or are yours, unless it was asked lately. Doesn't wait. */
  kickRequested(now = Date.now()): void {
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
    now = Date.now(),
    heads: string[] = [],
  ): void {
    const key = branchKey(repo, branch);
    const last = this.branches.get(key);
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
    this.branches.set(key, { at: now, pr: last?.pr, heads: asked, prHeads: last?.prHeads });
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
          this.branches.set(key, { at: now, pr, heads: asked });
        } else if (pr) {
          const current = this.branches.get(key);
          this.branches.set(key, {
            at: now,
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
        this.loadedBranches.delete(key);
        this.kept.branches[key] = { at: now, pr };
        this.save(now);
      })
      .catch(() => {
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
    const key = keyOf(repo, number);
    const last = this.checked.get(key);
    if (last && now - last.at < this.cacheMs) {
      return last;
    }
    const entry: Check = { at: now, facts: Promise.resolve(null), applied: new Set<string>() };
    entry.facts = this.check(repo, number)
      .then((facts) => {
        // a refresh replaces the entry: an older answer finishing later must not overwrite what the newer one found
        if (facts.info && this.checked.get(key) === entry) {
          this.known.set(key, facts.info);
          this.kept.prs[key] = { at: now, info: facts.info };
          this.save(now);
        }
        return facts;
      })
      .catch(() => null);
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
  kickInfo(repo: string, number: number, now = Date.now()): void {
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
    const lower = repo.toLowerCase();
    const follows =
      [...this.branches.keys()].some((key) => key.startsWith(`${lower}@`)) ||
      [...this.known.keys(), ...this.checked.keys()].some((key) => key.startsWith(`${lower}#`)) ||
      !!this.asked?.list.some((pr) => pr.repo.toLowerCase() === lower);
    if (!follows) {
      return false;
    }
    for (const [key, when] of this.refreshedAt) {
      if (now - when >= REFRESH_GAP_MS) {
        this.refreshedAt.delete(key);
      }
    }
    const gapKey = `${repo.toLowerCase()}@${branch ?? ''}#${number ?? ''}`;
    if (this.refreshedAt.has(gapKey)) {
      return false;
    }
    this.refreshedAt.set(gapKey, now);
    const numbers = new Set<number>(number ? [number] : []);
    let named = branch;
    if (number) {
      named = named ?? this.known.get(keyOf(repo, number))?.branch ?? null;
    }
    if (named) {
      const found = this.branches.get(branchKey(repo, named));
      if (found) {
        this.markBranchStale(branchKey(repo, named), found);
        if (found.pr) {
          numbers.add(found.pr.number);
        }
      }
      for (const [key, info] of this.known) {
        if (key.startsWith(`${repo.toLowerCase()}#`) && info.branch === named) {
          numbers.add(info.number);
        }
      }
    }
    if (number) {
      // a PR the branch check found, whose branch this ping didn't name
      for (const [key, found] of this.branches) {
        if (key.startsWith(`${repo.toLowerCase()}@`) && found.pr?.number === number) {
          this.markBranchStale(key, found);
        }
      }
    }
    for (const one of numbers) {
      this.checked.delete(keyOf(repo, one));
    }
    if (this.asked && now - this.listRefreshedAt >= LIST_GAP_MS) {
      this.listRefreshedAt = now;
      this.asked = { ...this.asked, at: 0 };
      // an ask already out started before what you did: its answer must not replace the stale mark
      this.askedSeq++;
    }
    return true;
  }

  /** Marks a branch's answer stale. An ask already out started before what you did, so it counts as an older one and can't clear the mark. */
  private markBranchStale(
    key: string,
    found: { at: number; pr: BranchPr | null | undefined; heads: string[] },
  ): void {
    this.branches.set(key, { ...found, at: 0 });
    this.branchSeq.set(key, (this.branchSeq.get(key) ?? 0) + 1);
  }

  /** Starts a check for each story's PR that wasn't asked about lately, and applies what it found to every listed story of that PR. Doesn't wait. */
  kick(list: InboxStory[], now = Date.now()): void {
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
   * with a reviewed.json (marked or unmarked by hand) as it is. The default branch is the checkout's last fetch of
   * origin, which the bridge never refreshes, so `delivered` can lag a fetch. A squash merge shows as a merged PR.
   */
  kickLocal(list: LocalEntry[], now = Date.now()): void {
    for (const entry of list) {
      const { story } = entry;
      if (entry.approval) {
        this.checkApproval(entry, now);
      }
      // a story you marked or unmarked by hand is left alone, but an approved one still gets the delivered check: pushing
      // it (Push on its page) is what ships it, and its card should clear then
      if (entry.marked && !entry.approval) {
        continue;
      }
      const onFeature = story.repo && story.branch && !DEFAULT_BRANCHES.has(story.branch);
      if ((!entry.marked || entry.approval) && onFeature && entry.repo_path) {
        this.kickBranch(
          story.repo as string,
          story.branch as string,
          entry.repo_path,
          now,
          [entry.head_oid, entry.approval?.head_oid].filter((oid): oid is string => !!oid),
        );
        // a loaded answer (from before this start) is shown, not acted on: marks are permanent
        const found = this.loadedBranches.has(
          branchKey(story.repo as string, story.branch as string),
        )
          ? undefined
          : this.branchPr(story.repo as string, story.branch as string);
        if (found && entry.approval) {
          // a squash merge leaves the approved head in no branch of the default one, so the merged PR is what shows it shipped:
          // the PR's last commit is the approved head, or the approved head is among its commits (GitHub added one since). An
          // open PR leaves the approval for the card to follow the PR.
          if (
            found.state === 'merged' &&
            (found.head_oid === entry.approval.head_oid ||
              found.shipped?.includes(entry.approval.head_oid))
          ) {
            this.markDelivered(story.id, entry.approval.head_oid, 'pr');
            continue;
          }
        } else if (found) {
          this.markLocal(story.id, 'pr');
          continue;
        }
      }
      const head = entry.head_oid;
      if (!entry.repo_path || !head || head === entry.base_oid || !FULL_SHA_RE.test(head)) {
        continue;
      }
      const key = `${story.id}@${head}`;
      const last = this.delivered.get(key);
      if (last !== undefined && now - last < this.cacheMs) {
        continue;
      }
      this.delivered.set(key, now);
      const checkout = entry.repo_path;
      const base = entry.base_oid && FULL_SHA_RE.test(entry.base_oid) ? entry.base_oid : null;
      const job = inDefaultBranch(checkout, head, { rewrittenFrom: onFeature ? null : base })
        .then((yes) => {
          if (yes) {
            this.markDelivered(story.id, head);
          }
        })
        .finally(() => this.running.delete(job));
      this.running.add(job);
    }
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
    const last = this.delivered.get(key);
    if (last !== undefined && now - last < this.cacheMs) {
      return;
    }
    this.delivered.set(key, now);
    const job = runGitAsync(checkout, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      timeout: 10000,
    })
      .then(({ code, stdout }) => {
        const tip = stdout.trim();
        const current = readApproval(this.stories, entry.story.id);
        if (
          code === 0 &&
          tip &&
          current?.head_oid === approval.head_oid &&
          tip !== approval.head_oid
        ) {
          clearApproval(this.stories, entry.story.id);
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
   * ends too (approved.json cleared, which takes it out of Ready to ship) and its mark becomes `delivered`, or `pr` when a
   * merged PR is what showed it (a squash merge).
   */
  private markDelivered(id: string, head: string, why: ReviewedBy = 'delivered'): void {
    const approval = readApproval(this.stories, id);
    if (approval && approval.head_oid === head) {
      this.stories.writeState(id, 'approved.json', null);
      markStoryReviewed(this.stories, id, true, why);
      return;
    }
    this.markLocal(id, why);
  }

  /** Writes a local story's done mark unless a hand mark or unmark got there first. */
  private markLocal(id: string, why: ReviewedBy): void {
    if (!storyHasState(this.stories, id)) {
      markStoryReviewed(this.stories, id, true, why);
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
