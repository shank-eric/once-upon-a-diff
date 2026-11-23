/*
 * The card keeper (ADR-29, branch B): turns what a board build learned (learned.ts) into stored cards, in shadow. It writes the
 * card for a PR, a story, a branch a session is on, or a build in flight, with the facts the build found; nothing reads those
 * cards yet, and listed cards (a backlog card) are only given the facts they lack, never a worktree. A failure never reaches the board.
 *
 * How it stays cheap and quiet (`apply` runs on every board build, about every 2 s while a page polls):
 *   - it reads the cards once, lock-free, and takes the backlog lock (inside `ensureCard`) only for a card that lacks a fact the
 *     build has; an unchanged build writes nothing and takes no lock (the lock is synchronous: a waiter blocks the bridge);
 *   - a fact a card already has is never rewritten (`ensureCard` fills only what is missing), so "holds" means the card has SOME value
 *     where the build has one, not the same value;
 *   - at most MAX_WRITES attempts a build, the rest wait for the next; a card whose write failed is left alone for RETRY_MS, and each
 *     such failure is logged once;
 *   - new work on a branch whose card is another PR's, or a PR seen merged or closed, is a new card: the old card (nothing lands or
 *     closes a stored card until a later branch) is passed over, not joined.
 */
import path from 'node:path';
import { CARD_BRANCH_RE, SESSION_RE, STORY_ID_RE } from '@once-upon-a-diff/terms/patterns';
import { prKey } from '@once-upon-a-diff/terms/ids';
import { REPO_RE } from '@once-upon-a-diff/foundation/repos';
import { newId } from '@once-upon-a-diff/foundation/ids';
import { BacklogStore, isListed } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { ensureCard, findCard } from '@once-upon-a-diff/state/queues/backlog/ensure';
import type { EnsureInput } from '@once-upon-a-diff/state/queues/backlog/ensure';
import type { BacklogItem } from '@once-upon-a-diff/state/queues/backlog/types';
import type { LearnedCard, LearnedCards } from './learned.ts';

/** Writes one build may attempt: after a restart every live work is new, and they are spread over the next builds. */
export const MAX_WRITES = 40;
/** How long a card whose write failed is left alone. */
export const RETRY_MS = 5 * 60 * 1000;
const TITLE_MAX = 200;
const WORKTREE_MAX = 500;

/** The learned card with the facts the store would refuse dropped, or null when its repo or branch is one (the store throws on those). */
function checked(card: LearnedCard): LearnedCard | null {
  if (!REPO_RE.test(card.repo) || !CARD_BRANCH_RE.test(card.branch)) {
    return null;
  }
  const title = card.title
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, TITLE_MAX)
    .trim();
  return {
    ...card,
    title: title || card.branch,
    worktree:
      card.worktree && path.isAbsolute(card.worktree) && card.worktree.length <= WORKTREE_MAX
        ? card.worktree
        : null,
    pr: card.pr && Number.isInteger(card.pr) && card.pr > 0 ? card.pr : null,
    story: card.story && STORY_ID_RE.test(card.story) ? card.story : null,
    session: card.session && SESSION_RE.test(card.session) ? card.session : null,
  };
}

export class CardKeeper {
  private store: BacklogStore;
  private log: (line: string) => void;
  /** PRs seen merged or closed (`repo#number`), kept for as long as this bridge runs */
  private ended = new Set<string>();
  /** PRs GitHub said were open in the build being applied */
  private open = new Set<string>();
  /** the cards whose write failed, until when to leave them alone */
  private failed = new Map<string, number>();

  constructor(home: string, log: (line: string) => void) {
    this.store = new BacklogStore(home);
    this.log = log;
  }

  /**
   * Whether this card is another work's: one PR's card on a branch now carrying another PR, a PR that was seen to end, or (work
   * that has no PR of its own) a PR this build did not see open. The last one is what a restart leaves: `ended` is lost with it, and a
   * reused branch name must not join the old PR's card.
   */
  private passedOver(item: BacklogItem, learned: LearnedCard): boolean {
    if (!item.pr) {
      return false;
    }
    if (learned.pr) {
      return item.pr !== learned.pr;
    }
    const key = prKey(item.repo ?? learned.repo, item.pr);
    if (this.ended.has(key)) {
      return true;
    }
    if (learned.asked) {
      return item.pr !== learned.asked;
    }
    return !this.open.has(key);
  }

  /** Whether the card already has a value for every fact the build has (a fact it has is not replaced, so it is not a reason to write). */
  private holds(item: BacklogItem, learned: LearnedCard): boolean {
    return (
      (!learned.repo || !!item.repo) &&
      (!learned.branch || !!item.branch) &&
      // a listed card is a person's: the checkout of the work is not written onto it (an old claim row's is, and its readers lean on that)
      (!learned.worktree || !!item.worktree || isListed(item)) &&
      (!learned.pr || !!item.pr) &&
      (!learned.story || !!item.story) &&
      (!learned.session || !!item.session)
    );
  }

  /**
   * The card `ensureCard` is to write to, as an `id` it takes as given: the one found, or a new one when the only match is a card
   * passed over (ensureCard would find that one first); nothing when no card matches, so ensureCard finds and adds under the lock.
   */
  private target(
    found: BacklogItem | undefined,
    items: BacklogItem[],
    facts: Omit<EnsureInput, 'title'>,
  ): { id?: string } {
    if (found) {
      return { id: found.id };
    }
    return findCard(items, facts) ? { id: newId('bl') } : {};
  }

  /** Writes what `learned` has that the stored cards lack. Never throws. */
  apply(learned: LearnedCards, nowMs: number = Date.now()): void {
    try {
      for (const ended of learned.ended) {
        this.ended.add(prKey(ended.repo, ended.number));
      }
      this.open = new Set(learned.open.map((one) => prKey(one.repo, one.number)));
      let items = this.store.items();
      let writes = 0;
      for (const raw of learned.cards) {
        if (writes >= MAX_WRITES) {
          break;
        }
        const card = checked(raw);
        const key = card && [card.repo, card.branch, card.pr, card.story, card.session].join('\0');
        if (!card || !key || (this.failed.get(key) ?? 0) > nowMs) {
          continue;
        }
        const facts: Omit<EnsureInput, 'title'> = {
          source: card.source,
          repo: card.repo,
          branch: card.branch,
          pr: card.pr,
          story: card.story,
          session: card.session,
          worktree: card.worktree,
        };
        const found = findCard(
          items.filter((item) => !this.passedOver(item, card)),
          facts,
        );
        if (found && this.holds(found, card)) {
          continue;
        }
        writes++;
        try {
          ensureCard(this.store, {
            ...facts,
            title: card.title,
            by: 'keeper',
            worktree: found && isListed(found) ? null : card.worktree,
            keepListedClear: true,
            ...this.target(found, items, facts),
          } as EnsureInput);
          items = this.store.items();
        } catch (err) {
          this.failed.set(key, nowMs + RETRY_MS);
          this.log(`card keeper: ${card.repo}@${card.branch}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.log(`card keeper: ${(err as Error).message}`);
    }
  }
}
