/*
 * The one story tag a PR gets, on PR lists and on the PR's Conversation tab.
 * The tag is the control:
 *   ready      "Story", a link to Files changed, where the panel docks; once they've read some of it (read.json),
 *              "Story · 2 of 5 read", linking to the first unread chapter, and "Read" (muted) once they've read it all
 *   stale      "Story out of date · Update", asks for an update to the PR's latest commit: a "Since you read it"
 *              chapter for the new commits (Update (new commits)), or with its small "Re-tell" a whole new story
 *   read+new   "Read · 3 new commits · Update" (or "2 of 5 read · …"), with "Re-tell" beside it, when they've read
 *              some of it and the PR has moved on
 *   none       "Build story", asks for one
 *   queued     "Queued", asked for and no session has it yet (not clickable)
 *   building   "Building…", a session claimed it (not clickable)
 *   updating   "Update queued" / "Updating…", or "Rebuild queued" / "Rebuilding…" for the panel's Rebuild (not clickable)
 * Who's listening is said once per page, per repo, by the notice (components/listen-notice.ts), not on each tag.
 *
 * What a tag says and does, as data: no DOM, no Preact and no chrome.* here, so node can test it. components/story-tag.ts draws it.
 */
import { plural, shortSha } from '@once-upon-a-diff/terms/text';
import { clockTime } from '@once-upon-a-diff/terms/time';
import type { Listening, PrRef, StoryStatus } from '@once-upon-a-diff/contracts/types';
import { prUrl } from '@once-upon-a-diff/terms/github-urls';

export type { PrRef, StoryStatus };

/** What a tag shows and does. */
export interface Tag {
  kind: 'link' | 'button' | 'progress';
  cls: string;
  label: string;
  title: string;
  href?: string;
  act?: 'build' | 'update';
  spin?: boolean;
  base?: string | null;
  alt?: { act: 'retell'; label: string; title: string };
}

/** A "no session listening" line for a repo. */
export interface MissingListener {
  repo: string;
  prompt: string;
  details: string;
  checkout: string | null;
}

/** A tag with no story to show: "Build story", asking for one (the last build's failure goes in its hover). */
function buildTag(result: StoryStatus | null | undefined): Tag {
  const failed = !!result && !!result.request && result.request.status === 'failed';
  return {
    kind: 'button',
    act: 'build',
    cls: '',
    label: 'Build story',
    title: `Ask a Claude session to write a story for this PR${failed ? '. The last build failed.' : ''}`,
  };
}

/** The not-clickable tag of a story asked for and not done: queued, or building. */
function progressTag(building: boolean, label: string, title: string): Tag {
  return building
    ? { kind: 'progress', cls: 'building', label, spin: true, title }
    : { kind: 'progress', cls: 'queued', label, title };
}

/** The tag of a story that is queued or building, or null once it is built. */
function buildingTag(result: StoryStatus, asked: string): Tag | null {
  if (result.state === 'queued') {
    return progressTag(
      false,
      'Queued',
      `A story was asked for${asked}. No session has taken it yet.`,
    );
  }
  if (result.state === 'building') {
    return progressTag(
      true,
      'Building…',
      `A Claude session is building the story (asked for${asked})`,
    );
  }
  return null;
}

/** The tag of a story being brought up to date or rebuilt, or null when no update is under way. */
function updatingTag(result: StoryStatus): Tag | null {
  if (!result.updating) {
    return null;
  }
  const building = result.update_state === 'building';
  if (result.update_kind === 'rebuild') {
    return building
      ? progressTag(true, 'Rebuilding…', 'A Claude session is rebuilding the story')
      : progressTag(
          false,
          'Rebuild queued',
          'A rebuild of the story was asked for. No session has taken it yet.',
        );
  }
  return building
    ? progressTag(true, 'Updating…', 'A Claude session is updating the story to the latest commit')
    : progressTag(
        false,
        'Update queued',
        'An update to the latest commit was asked for. No session has taken it yet.',
      );
}

/** The small "Re-tell" beside a stale tag: a whole new story at the latest commit. */
const RETELL = {
  act: 'retell' as const,
  label: 'Re-tell',
  title:
    'Re-tell from scratch: a whole new story at the latest commit, for a rebase or a big rework',
};

/** How many chapters they have read: reads of a story with chapters, else null. */
type ReadCount = NonNullable<StoryStatus['reads']>;
const readCountOf = (result: StoryStatus): ReadCount | null =>
  result.reads && result.reads.total ? result.reads : null;

/** The tag of a story the PR has moved past: "Update", with "Re-tell" beside it. */
function staleTag(result: StoryStatus, readCount: ReadCount | null): Tag {
  if (!readCount || !readCount.read) {
    return {
      kind: 'button',
      act: 'update',
      base: result.story_head,
      cls: 'stale',
      label: 'Story out of date · Update',
      title:
        `Update (new commits): the story is for ${shortSha(result.story_head)} and the PR has newer commits (${shortSha(result.current_head)}). ` +
        'Adds a "Since you read it" chapter for them, first, and keeps the chapters you read.',
      alt: RETELL,
    };
  }
  const all = readCount.read >= readCount.total;
  const newer = Number.isFinite(result.newer) ? (result.newer as number) : null;
  const readSoFar = all ? 'Read' : `${readCount.read} of ${readCount.total} read`;
  const newCommits = newer == null ? 'new commits' : plural(newer, 'new commit');
  const label = `${readSoFar} · ${newCommits} · Update`;
  return {
    kind: 'button',
    act: 'update',
    base: result.story_head,
    cls: 'stale',
    label,
    title:
      `Update (new commits): you've read ${all ? 'the story' : `${readCount.read} of its ${readCount.total} chapters`}, and the PR has moved on from ${shortSha(result.story_head)} to ${shortSha(result.current_head)}. ` +
      'Adds a "Since you read it" chapter for the new commits, first, and keeps the chapters you read.',
    alt: RETELL,
  };
}

/** The link tag of a story that is up to date: "Read", "Story · 2 of 5 read", or plain "Story". */
function readingTag(result: StoryStatus, readCount: ReadCount | null, href: string): Tag {
  const upTo = result.story_head ? ` (up to date with ${shortSha(result.story_head)})` : '';
  if (!readCount || !readCount.read) {
    return {
      kind: 'link',
      href,
      cls: 'ready',
      label: 'Story',
      title: `Open the story on Files changed${upTo}`,
    };
  }
  if (readCount.read >= readCount.total) {
    return {
      kind: 'link',
      href,
      cls: 'read',
      label: 'Read',
      title: `You've read all ${readCount.total} chapters${upTo}. Opens the story on Files changed.`,
    };
  }
  // the panel opens on the step a #ou-step-N hash names (pages/files-changed.js)
  return {
    kind: 'link',
    href: readCount.next ? `${href}#ou-step-${readCount.next}` : href,
    cls: 'ready',
    label: `Story · ${readCount.read} of ${readCount.total} read`,
    title: `You've read ${readCount.read} of ${readCount.total} chapters${upTo}. Opens the first one you haven't read.`,
  };
}

/** What the tag shows and does, from a status-many result. */
export function tagFor(result: StoryStatus | null | undefined, { repo, number }: PrRef): Tag {
  if (!result || result.state === 'none' || !result.state) {
    return buildTag(result);
  }
  const asked = result.request?.requested_at ? ` at ${clockTime(result.request.requested_at)}` : '';
  const readCount = readCountOf(result);
  return (
    buildingTag(result, asked) ??
    updatingTag(result) ??
    (result.stale
      ? staleTag(result, readCount)
      : readingTag(result, readCount, prUrl(repo, number, 'changes')))
  );
}

/** Does a Files changed URL's #ou-ask hash ask for the panel's Ask dock to open? */
export const wantsAskDock = (hash: string | null | undefined): boolean => hash === '#ou-ask';

/** The badge beside a PR's tag: what it says and where it links. */
export interface AnswersBadge {
  href: string;
  label: string;
  title: string;
}

/**
 * The badge beside a PR's tag when answers to its questions wait unread: "1 new answer", linking Files changed with the
 * Ask dock open. null when there are none. It is not a tag of its own: tagFor's one tag stays one.
 */
export function answersBadge(
  result: StoryStatus | null | undefined,
  { repo, number }: PrRef,
): AnswersBadge | null {
  const count = result && result.state === 'ready' ? result.unread_answers || 0 : 0;
  if (count < 1) {
    return null;
  }
  return {
    href: `${prUrl(repo, number, 'changes')}#ou-ask`,
    label: plural(count, 'new answer'),
    title: `${count === 1 ? 'An answer' : 'Answers'} to your question${count === 1 ? '' : 's'} in the story ${count === 1 ? 'is' : 'are'} unread. Opens the story with the Ask box open.`,
  };
}

/**
 * The panel state to open with: the Ask dock open when the URL asks for it (#ou-ask) and hasn't been honoured for this
 * URL yet, so closing the dock stays closed. `opened` is the URL it last opened the dock for.
 */
export function withAskDock<Ui extends object>(
  panel: Ui,
  { hash, href, opened }: { hash: string | null | undefined; href: string; opened?: string },
): { panel: Ui | (Ui & { chatOpen: true }); opened: string | undefined } {
  if (!wantsAskDock(hash) || opened === href) {
    return { panel, opened };
  }
  return { panel: { ...panel, chatOpen: true }, opened: href };
}

/** The step a Files changed URL's #ou-step-N hash asks the panel to open on, or null. */
export function stepOfHash(hash: string | null | undefined): number | null {
  const match = /^#ou-step-(\d{1,3})$/.exec(String(hash || ''));
  return match ? Number(match[1]) : null;
}

/** What POST /api/builds takes: a PR, and for an update the commit the story was told from. */
export interface BuildRequestBody {
  repo: string;
  number: number;
  url: string;
  requested_at: string;
  mode?: 'update';
  base_sha?: string;
  retell?: boolean;
}

/** The build request a button tag sends. retell: the stale tag's "Re-tell" was clicked. */
export function requestFor(
  tag: Pick<Tag, 'act' | 'base'>,
  { repo, number }: PrRef,
  { retell = false } = {},
): BuildRequestBody {
  const body = {
    repo,
    number,
    url: prUrl(repo, number),
    requested_at: new Date().toISOString(),
  };
  return tag.act === 'update' && tag.base
    ? { ...body, mode: 'update' as const, base_sha: tag.base, ...(retell ? { retell: true } : {}) }
    : body;
}

/**
 * The page's "no session listening" lines: one per repo on the page whose listener is missing. listening is by repo.
 */
export function missingListeners(
  listening: Record<string, Partial<Listening> | null> | null | undefined,
): MissingListener[] {
  return Object.entries(listening || {})
    .filter(([, listener]) => listener && !listener.ok && listener.prompt)
    .map(([repo, listener]) => ({
      repo,
      prompt: listener!.prompt as string, // the filter keeps only listeners with a prompt
      details: listener!.details || '',
      checkout: listener!.checkout || null,
    }));
}

/**
 * The hover of one line of the notice: no session listening for this repo, and what Start listening does (the bridge types the
 * listen line into an idle Claude Code session in the repo). It gives the long form for a session without the skill, to type
 * by hand when no session can be typed into.
 */
export function noticeRowTitle(row: MissingListener): string {
  const how = row.checkout
    ? `Types ${row.prompt} into an idle Claude Code session in ${row.checkout}. With none, start Claude Code there and run it.`
    : `Types ${row.prompt} into an idle Claude Code session in your ${row.repo} checkout. With none, start Claude Code there and run it.`;
  return `${how}${row.details ? `\n\nWithout the once-upon-listen skill: ${row.details}` : ''}`;
}
