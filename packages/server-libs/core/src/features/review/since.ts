/**
 * What a local story's Update starts from, and what the storyteller needs to tell it: where the reviewer's reading
 * stopped (read.json, else the commits the chapters were told over) and what the story's diff changed since. Update is
 * asked from the panel (the story route) or `once-upon update`, and `once-upon since` prints the report; none of them
 * calls the bridge.
 */
import { commitOf, commitsBetween, isAncestor } from '@once-upon-a-diff/adapters/git';
import { readMeta, stateKeyOf } from '@once-upon-a-diff/stories/meta';
import { refreshLocal } from '@once-upon-a-diff/stories/local-diff';
import { readReads, sinceOf } from '@once-upon-a-diff/stories/reads';
import type { Reads, Since } from '@once-upon-a-diff/stories/reads';
import type { LocalMeta, StoryMeta } from '@once-upon-a-diff/stories/types';
import type { Chapter } from '@once-upon-a-diff/contracts/types';
import { liveRange, localChanges } from './freshness.ts';

/** Where an Update of the story starts: the story as it is now, and `sinceOf` for its reads. */
export function localUpdateStart(home: string, dir: string, id: string, chapters: Chapter[]) {
  const meta = readMeta(dir);
  const reads = readReads(home, stateKeyOf(id, meta));
  return { meta, reads, since: sinceOf(reads, chapters, meta.told_head_oid || null) };
}

/** The base the reading at `since` was made over: the read's own, else the one the chapters were told over, else now's. */
function baseOfRead(meta: StoryMeta, reads: Reads, since: Since): string | null {
  const read = since.chapter ? reads[since.chapter] : null;
  return (read && read.base_sha) || meta.told_base_oid || meta.base_oid || null;
}

/** The git command that shows what changed: a diff when the base stayed, a range-diff when it moved too. */
const commandFor = (
  baseMoved: boolean,
  { thenBase, sinceSha, base, head }: Record<'thenBase' | 'sinceSha' | 'base' | 'head', string>,
) =>
  baseMoved
    ? `git range-diff ${thenBase}..${sinceSha} ${base}..${head}`
    : `git diff ${sinceSha} ${head}`;

/** `once-upon since --story`: the facts a "Since you read it" chapter is told from. Throws when the story isn't a local one with a told plan. */
export function sinceReport(home: string, dir: string, id: string, chapters: Chapter[]) {
  const raw = readMeta(dir);
  if (raw.kind !== 'local' || !raw.told_head_oid) {
    throw new Error(`${id} is not a local story with a told plan: there is nothing to update`);
  }
  const meta: StoryMeta = refreshLocal(dir, raw as LocalMeta); // the checkout may have moved since the page last polled
  const { reads, since } = localUpdateStart(home, dir, id, chapters);
  const repo = meta.repo_path as string;
  const { head, base } = liveRange(meta) as { head: string; base: string }; // a pinned story is still at its told range
  const sinceSha = since.since_sha || (meta.told_head_oid as string);
  const thenBase = baseOfRead(meta, reads, since) || base;
  const readable = !!commitOf(repo, sinceSha) && !!commitOf(repo, thenBase);
  const baseMoved = thenBase !== base;
  const files = readable
    ? [...localChanges(repo, { base: thenBase, head: sinceSha }, { base, head }).keys()]
    : [];
  return {
    story: id,
    source: since.source,
    since_sha: sinceSha,
    head,
    base,
    since_base: thenBase,
    readable,
    ancestor: readable && isAncestor(repo, sinceSha, head),
    base_moved: baseMoved,
    commits: readable ? commitsBetween(repo, sinceSha, head).length : null,
    changed_files: files,
    command: readable ? commandFor(baseMoved, { thenBase, sinceSha, base, head }) : null,
  };
}
