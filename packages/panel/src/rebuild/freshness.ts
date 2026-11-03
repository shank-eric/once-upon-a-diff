/*
 * Is the story up to date with the PR's latest commit (opts.freshness)? A
 * stale story says so under the toolbar, with Update and Re-tell buttons
 * (marks.js marks the files and chapters that changed since). A story updated
 * in place says what the update brought in. And the banner at the top of a "Since you
 * read it" chapter, with a link to GitHub's diff of just its commits.
 *
 * rangeStepOf and rangeUrl have no DOM, so node tests can use them.
 */
import { html } from '@once-upon-a-diff/protocol/domain/html';
import { setHtml } from '../dom.ts';
import { plural, sameSha, shortSha } from '@once-upon-a-diff/protocol/domain/text';
import { clockTime, minutesSince } from '@once-upon-a-diff/protocol/domain/time';
import { rangeOfPath } from '@once-upon-a-diff/protocol/domain/pr-key';
import type { PanelContext } from '../context.ts';
import type { Chapter, Freshness, StoryRequest } from '@once-upon-a-diff/protocol/types';

export { rangeOfPath };

/** The step (1-based) of the "Since you read it" chapter for the range this page shows, or null. */
export function rangeStepOf(
  chapters: { since?: { from: string; to: string } }[],
  pathname: string,
): number | null {
  const range = rangeOfPath(pathname);
  if (!range) {
    return null;
  }
  const index = chapters.findIndex(
    (chapter) =>
      chapter.since &&
      sameSha(chapter.since.from, range.from) &&
      sameSha(chapter.since.to, range.to),
  );
  return index < 0 ? null : index + 1;
}

/**
 * The link to GitHub's diff of just a chapter's commits. /changes/<from>..<to> loads as is logged in
 * (checked 2026-10-22) and redirects to /files/<from>..<to> logged out.
 */
export const rangeUrl = (
  prUrl: string | null | undefined,
  since: { from: string; to: string } | null | undefined,
): string | null =>
  prUrl && since ? `${String(prUrl).replace(/\/+$/, '')}/changes/${since.from}..${since.to}` : null;

const DOING: Record<StoryRequest['kind'], string> = {
  build: 'Building the story for you…',
  update: 'Updating the story for you…',
  rebuild: 'Rebuilding the story for you…',
  fix: 'Fixing the code for you…',
};

/**
 * What to say while a session has a request for the story, instead of offering Update: building once a listener has
 * taken it (when it started, and who), queued until one does (when it was asked). No DOM, so node tests can use it.
 */
export function requestLine(
  request: StoryRequest | null | undefined,
  now = Date.now(),
): { text: string; detail: string } | null {
  if (!request) {
    return null;
  }
  const asked = clockTime(request.requested_at);
  if (request.state === 'queued') {
    return {
      text: 'Waiting for a Claude session to pick this up…',
      detail: asked ? `asked at ${asked}` : '',
    };
  }
  const minutes = minutesSince(request.claimed_at || request.requested_at, now);
  const started = clockTime(request.claimed_at || request.requested_at);
  const detail = [
    started &&
      `started ${started}${minutes !== null && minutes >= 1 ? ` (${minutes} min ago)` : ''}`,
    request.claimed_by,
  ]
    .filter(Boolean)
    .join(', ');
  return { text: DOING[request.kind], detail };
}

const UPDATE_TITLE =
  'Adds a “Since you read it” chapter for the new commits, first, and keeps the chapters you read';
const RETELL_TITLE = 'A whole new story at the latest commit, for a rebase or a big rework';

export function createFreshness(context: PanelContext) {
  const { story, opts, shell } = context;
  const { data } = story;
  const { $ } = shell;
  let fresh: Freshness | null = null;
  let request: StoryRequest | null = null; // the pulse's request: a session is at work on the story

  async function refresh() {
    if (!opts.freshness) {
      // nothing to ask, but a request line's "(N min ago)" moves on with the clock
      if (request) {
        render();
      }
      return;
    }
    try {
      fresh = await opts.freshness();
    } catch (e) {
      fresh = { state: 'unknown', error: (e && (e as Error).message) as string | null };
    }
    render();
    context.marks.render();
  }

  /** ", in chapter 1, chapter 3" for the chapters that list the changed files */
  const inChapters = (touched: number[]) =>
    touched.length ? `, in ${touched.map(story.chapterName).join(', ')}` : '';

  function wireUpdateButtons(box: HTMLElement) {
    for (const button of box.querySelectorAll<HTMLButtonElement>('.ou-update')) {
      button.onclick = async () => {
        const retell = button.getAttribute('data-retell') === '1';
        for (const other of box.querySelectorAll<HTMLButtonElement>('.ou-update')) {
          other.disabled = true;
        }
        try {
          await opts.requestUpdate!(fresh!.story_head, { retell }); // the buttons show only with both
          button.textContent = retell ? 'Re-tell asked for' : 'Update asked for';
          shell.message(
            retell
              ? 'Asked for a new story from scratch. A Claude session picks it up from the inbox.'
              : 'Asked for a “Since you read it” chapter for the new commits. A Claude session picks it up from the inbox.',
          );
        } catch (e) {
          for (const other of box.querySelectorAll<HTMLButtonElement>('.ou-update')) {
            other.disabled = false;
          }
          shell.message(
            `Couldn't ask for an update: ${e && (e as Error).message ? (e as Error).message : e}`,
          );
        }
      };
    }
  }

  /** The in-progress line, with a spinner, for the pulse's request (null when there is none). */
  function progressHtml() {
    const line = requestLine(request);
    return (
      line &&
      html`<span class="ou-busy" role="status"><span class="ou-spin" aria-hidden="true"></span>${line.text}${line.detail && html` <span class="ou-why">${line.detail}</span>`}</span>`
    );
  }

  /**
   * The pulse's `request`: while a session has one for the story, Update gives way to the in-progress line. When it
   * ends the story has a new version (or the request failed), so freshness is asked again to bring Update back, or not.
   */
  function setRequest(next: StoryRequest | null | undefined) {
    const value = next || null;
    if (JSON.stringify(value) === JSON.stringify(request)) {
      return;
    }
    const ended = !!request && !value;
    request = value;
    render();
    if (ended) {
      refresh();
    }
  }

  function render() {
    const box = $('.ou-fresh')!;
    box.classList.remove('ou-stale');
    // a rebuild has its own status line under the toolbar, so only the other requests say so here, unless Update is what they replace
    const progress =
      request && (request.kind !== 'rebuild' || fresh?.state === 'stale') ? progressHtml() : null;
    if (!fresh || fresh.state === 'n/a') {
      setHtml(box, progress);
      return;
    }
    if (fresh.state === 'current') {
      setHtml(
        box,
        html`${updatedHtml(fresh) || html`<span class="ou-why">Up to date with ${shortSha(fresh.story_head)}</span>`}${progress && html` `}${progress}`,
      );
      return;
    }
    if (fresh.state === 'unknown') {
      setHtml(
        box,
        html`${fresh.error && html`<span class="ou-why" title="${fresh.error}">Can't tell whether the story is up to date</span>`}${progress}`,
      );
      return;
    }
    box.classList.add('ou-stale');
    const newer = fresh.newer;
    let what = 'the PR has newer commits';
    if (fresh.rewritten) {
      what = 'the PR was rebased or force-pushed since';
    } else if (newer != null) {
      what = `the PR has ${plural(newer, 'newer commit')}`;
    }
    const files = (fresh.changed_files || []).length;
    const changed = files
      ? ` (${plural(files, 'file')} changed${inChapters(fresh.chapters_touched || [])})`
      : '';
    const rebased =
      fresh.rewritten &&
      html`<span class="ou-why">It was rebased, so a re-tell is likely the better fit.</span>`;
    const update = html`<button class="ou-update" data-retell="0" title="${UPDATE_TITLE}">Update (new commits)</button>`;
    const retell = html`<button class="ou-update" data-retell="1" title="${RETELL_TITLE}">Re-tell from scratch</button>`;
    // no Update or Re-tell while a session is at work on the story: it would only queue a second request
    const buttons = progress || (opts.requestUpdate && html`${update}${retell}${rebased}`);
    setHtml(box, html`Story is for ${shortSha(fresh.story_head)}; ${what}${changed}.${buttons}`);
    if (!progress) {
      wireUpdateButtons(box);
    }
  }

  /**
   * A story updated in place (no "Since you read it" chapter for the update): say so at the top, with what the new
   * commits changed and a link to GitHub's diff of just them, so what's new stays apart from what they'd seen.
   */
  function updatedHtml(freshness: Freshness | null) {
    const updated = freshness && freshness.updated;
    if (!updated) {
      return null;
    }
    const commits = updated.newer != null ? plural(updated.newer, 'new commit') : 'New commits';
    const files = (updated.changed_files || []).length;
    const changed = files
      ? `. They changed ${plural(files, 'file')}${inChapters(updated.chapters_touched || [])}`
      : '';
    const url = context.hostName === 'GitHub' ? rangeUrl(data.pr && data.pr.url, updated) : null;
    const how = updated.retold
      ? 're-told from scratch'
      : 'updated in place, with no “Since you read it” chapter';
    const range = `${shortSha(updated.from)}..${shortSha(updated.to)}`;
    const link =
      url &&
      html` <a href="${url}" title="GitHub's Files changed for ${range} only">See just what's new on GitHub</a>`;
    return html`<b>${commits} since ${shortSha(updated.from)}</b>: the story was ${how}${changed}.${link} <span class="ou-why">Up to date with ${shortSha(freshness.story_head)}</span>`;
  }

  /** At the top of a "Since you read it" chapter: which commits it covers, and that the rest is as they read it. */
  function sinceBanner(chapter: Chapter | null) {
    if (!chapter || !chapter.since) {
      return null;
    }
    const count = chapter.since.commits;
    const what = `${count != null ? plural(count, 'commit') : 'The commits'} since you read the story`;
    const rest = data.chapters.some((other) => !other.since)
      ? ' The chapters after this one are as you read them.'
      : '';
    // GitHub's diff of just these commits (the filter here shows the files they touched, but each file's whole PR diff)
    const url =
      context.hostName === 'GitHub' ? rangeUrl(data.pr && data.pr.url, chapter.since) : null;
    const here = url && rangeStepOf([chapter], location.pathname) === 1;
    const range = `${shortSha(chapter.since.from)}..${shortSha(chapter.since.to)}`;
    let link = null;
    if (url && here) {
      link = html` You're on GitHub's diff of just these commits. <a href="${data.pr.url}/changes">All of the PR's changes</a>`;
    } else if (url) {
      link = html` <a href="${url}" title="GitHub's Files changed for ${range} only">See just these commits' changes on GitHub</a>`;
    }
    return html`<div class="ou-since"><b>${what}</b>, ${range}. This step shows only the files they touched.${rest}${link}</div>`;
  }

  return {
    get current() {
      return fresh;
    },
    refresh,
    render,
    setRequest,
    sinceBanner,
  };
}

export type FreshnessPart = ReturnType<typeof createFreshness>;
