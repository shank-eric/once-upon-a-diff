/**
 * What changed on an approved story's branch since the approval, for the page to say when the approval lapses. The
 * approved commits (the approval's `base_oid..head_oid`) are compared with the commits on the branch now by the rule
 * carry-approval.ts uses, `git patch-id --stable` (a reworded message is the same commit), so "lapsed" and "what
 * changed" cannot disagree. A commit whose message and patch both changed reads as one dropped and one added.
 */
import { commitLog, mergeBase } from '@once-upon-a-diff/adapters/git';
import type { LocalCommit, LocalLapse, LocalLapseChange } from '@once-upon-a-diff/contracts/types';
import type { StoryStore } from '@once-upon-a-diff/stories/store';
import { readMeta } from '@once-upon-a-diff/stories/meta';
import type { Approval } from '@once-upon-a-diff/stories/approval';
import type { LocalMeta } from '@once-upon-a-diff/stories/types';
import { baseRefs, patchIdOr } from './carry-approval.ts';
import type { LocalEntry } from './story-lists.ts';

/** More commits than this on either side, or more changes than this, are not listed. */
const MAX_COMMITS = 30;

/**
 * The commits that differ between `approved` and `now` (both newest first, as `commitLog` gives them). `idOf` is a commit's
 * patch id, null for an empty one; it is asked lazily, only for commits whose sha is not on both sides. At most
 * MAX_COMMITS changes come back, with `more` the number left out.
 */
export function commitChanges(
  approved: LocalCommit[],
  now: LocalCommit[],
  idOf: (sha: string) => string | null,
): { changes: LocalLapseChange[]; more: number } {
  const approvedAt = new Map(approved.map((commit, index) => [commit.sha, index]));
  const used = new Set<number>();
  // current index -> approved index, for the commits that are the same patch
  const same = new Map<number, number>();
  now.forEach((commit, index) => {
    const found = approvedAt.get(commit.sha);
    if (found !== undefined) {
      same.set(index, found);
      used.add(found);
    }
  });
  // the rest pair by patch id, one for one (an empty commit pairs with an empty one of the same subject)
  const keyOf = (commit: LocalCommit): string => {
    const id = idOf(commit.sha);
    return id ? `id:${id}` : `empty:${commit.subject}`;
  };
  const free = new Map<string, number[]>();
  approved.forEach((commit, index) => {
    if (!used.has(index)) {
      const key = keyOf(commit);
      free.set(key, [...(free.get(key) ?? []), index]);
    }
  });
  const unpaired: number[] = [];
  now.forEach((commit, index) => {
    if (same.has(index)) {
      return;
    }
    const match = free.get(keyOf(commit))?.shift();
    if (match === undefined) {
      unpaired.push(index);
    } else {
      same.set(index, match);
      used.add(match);
    }
  });
  // then by subject: the patch changed under the same message
  const edited = new Map<number, number>();
  for (const index of unpaired) {
    const match = approved.findIndex(
      (commit, slot) => !used.has(slot) && commit.subject === now[index]!.subject,
    );
    if (match >= 0) {
      edited.set(index, match);
      used.add(match);
    }
  }
  // of the unchanged ones, those outside the longest run that keeps the approved order were moved
  const order = [...same.entries()].sort((left, right) => left[0] - right[0]);
  const best: number[] = order.map(() => 1);
  const prev: number[] = order.map(() => -1);
  let top = -1;
  order.forEach(([, here], i) => {
    for (let j = 0; j < i; j++) {
      if (order[j]![1] < here && best[j]! + 1 > best[i]!) {
        best[i] = best[j]! + 1;
        prev[i] = j;
      }
    }
    if (top < 0 || best[i]! > best[top]!) {
      top = i;
    }
  });
  const kept = new Set<number>();
  for (let i = top; i >= 0; i = prev[i]!) {
    kept.add(order[i]![0]);
  }
  const all: LocalLapseChange[] = [];
  now.forEach((commit, index) => {
    const editedFrom = edited.get(index);
    const sameAs = same.get(index);
    if (editedFrom !== undefined) {
      all.push({
        kind: 'edited',
        sha: commit.sha,
        subject: commit.subject,
        was: approved[editedFrom]!.sha,
      });
    } else if (sameAs !== undefined) {
      if (!kept.has(index)) {
        all.push({
          kind: 'reordered',
          sha: commit.sha,
          subject: commit.subject,
          was: approved[sameAs]!.sha,
        });
      }
    } else {
      all.push({ kind: 'added', sha: commit.sha, subject: commit.subject });
    }
  });
  approved.forEach((commit, index) => {
    if (!used.has(index)) {
      all.push({ kind: 'dropped', sha: commit.sha, subject: commit.subject });
    }
  });
  return { changes: all.slice(0, MAX_COMMITS), more: Math.max(0, all.length - MAX_COMMITS) };
}

/**
 * The lapse note for an approval the branch has left: the approved commits compared with the commits from the branch's
 * merge-base with the story's base ref (told, origin's default, main, master: the nearest to `tip`, as carry tries them all) to `tip`; a branch reset to its base
 * has no commits left, so every approved one reads as dropped. Null, so
 * no note, when nothing can be compared (no base commit, a range over 30 commits, git trouble) or nothing differs (the
 * lapse had another reason: the approval aged out, an empty commit). Never throws: the lapse itself must not wait on this.
 */
export function lapseChangesOf(
  stories: StoryStore,
  entry: LocalEntry,
  approval: Approval,
  tip: string,
  now = Date.now(),
): LocalLapse | null {
  try {
    const repo = entry.repo_path;
    if (!repo || !approval.base_oid) {
      return null;
    }
    const approved = commitLog(repo, [`${approval.base_oid}..${approval.head_oid}`]);
    if (!approved.length || approved.length > MAX_COMMITS) {
      return null;
    }
    const dir = stories.dirOf(entry.story.id);
    const told = dir ? (readMeta(dir) as LocalMeta | null)?.base : undefined;
    // every base ref carry's rebasedOnto tries; the nearest merge-base (the shortest range) is where the branch's own
    // commits start, so a branch rebased onto origin's main is not compared from a stale local main
    let current: LocalCommit[] | null = null;
    for (const ref of new Set(baseRefs(repo, told))) {
      try {
        const range = commitLog(repo, [`${mergeBase(repo, ref, tip)}..${tip}`]);
        if (!current || range.length < current.length) {
          current = range;
        }
      } catch {
        // the ref is not here
      }
    }
    if (!current || current.length > MAX_COMMITS) {
      return null;
    }
    const idOf = (sha: string): string | null => patchIdOr(repo, sha);
    const { changes, more } = commitChanges(approved, current, idOf);
    return changes.length
      ? { at: new Date(now).toISOString(), tip, changes, ...(more && { more }) }
      : null;
  } catch {
    return null;
  }
}
