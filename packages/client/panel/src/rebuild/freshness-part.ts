/*
 * Is the story up to date with the PR's latest commit (opts.freshness)? A stale story says so under the toolbar, with Update and
 * Re-tell buttons (marks.js marks the files and chapters that changed since). A story updated in place says what the update
 * brought in. And the banner at the top of a "Since you read it" chapter, with a link to GitHub's diff of just its commits.
 *
 * render() works out what the line says (the request line's minutes come from the clock then, not when the panel is drawn by
 * something else) and the view draws it. The Update buttons' "asked for" is reset where the old panel rebuilt the line: by render().
 */
import { html } from '/assets/preact.mjs';
import { Banner } from '@once-upon-a-diff/ui-kit/components/banner';
import { Busy } from '@once-upon-a-diff/ui-kit/components/busy';
import { plural, shortSha } from '@once-upon-a-diff/terms/text';
import { rangeStepOf, rangeUrl, requestLine } from './freshness.ts';
import type { PanelContext } from '../host/context.ts';
import type { Chapter, Freshness, StoryRequest } from '@once-upon-a-diff/contracts/types';

const UPDATE_TITLE =
  'Adds a “Since you read it” chapter for the new commits, first, and keeps the chapters you read';
const RETELL_TITLE = 'A whole new story at the latest commit, for a rebase or a big rework';

/** What the "Since you read it" banner says: worked out when the body is drawn, from the chapter and the page's address. */
export interface SinceModel {
  what: string;
  range: string;
  rest: string;
  link: { kind: 'here'; all: string } | { kind: 'url'; url: string; range: string } | null;
}

export function createFreshness(context: PanelContext) {
  const { story, opts, shell } = context;
  const { data } = story;
  let fresh: Freshness | null = null;
  let request: StoryRequest | null = null; // the pulse's request: a session is at work on the story
  let progress: { text: string; detail: string } | null = null; // the request line as render() worked it out
  let asking = false; // an Update or Re-tell is out
  let asked: 'update' | 'retell' | null = null; // the one that was asked for
  let round = 0; // a draw of the line: an answer to an ask from before it shows nothing on it

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

  async function ask(retell: boolean) {
    if (asking || asked) {
      return;
    }
    const mine = round;
    asking = true;
    shell.redraw(); // all the buttons go off at once
    try {
      await opts.requestUpdate!(fresh!.story_head, { retell }); // the buttons show only with both
      if (mine === round) {
        asked = retell ? 'retell' : 'update';
        shell.redraw();
      }
      shell.message(
        retell
          ? 'Asked for a new story from scratch. A Claude session picks it up from the inbox.'
          : 'Asked for a “Since you read it” chapter for the new commits. A Claude session picks it up from the inbox.',
      );
    } catch (e) {
      if (mine === round) {
        asking = false;
        shell.redraw();
      }
      shell.message(
        `Couldn't ask for an update: ${e && (e as Error).message ? (e as Error).message : e}`,
      );
    }
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

  /** Works out the in-progress line, and has the panel draw it. */
  function render() {
    round++;
    asking = false;
    asked = null;
    // a rebuild has its own status line under the toolbar, so only the other requests say so here, unless Update is what they replace
    progress =
      request && (request.kind !== 'rebuild' || fresh?.state === 'stale')
        ? requestLine(request)
        : null;
    shell.redraw();
  }

  // ---------- views

  /** The in-progress line, with a spinner, for the pulse's request (null when there is none). */
  const progressView = () =>
    progress &&
    html`<${Busy}>${progress.text}${progress.detail && html` <span class="ou-why">${progress.detail}</span>`}</${Busy}>`;

  /**
   * A story updated in place (no "Since you read it" chapter for the update): say so at the top, with what the new
   * commits changed and a link to GitHub's diff of just them, so what's new stays apart from what they'd seen.
   */
  function updatedView(freshness: Freshness) {
    const updated = freshness.updated;
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
      html` <a href=${url} title=${`GitHub's Files changed for ${range} only`}>See just what's new on GitHub</a>`;
    return html`<b>${commits} since ${shortSha(updated.from)}</b>: the story was ${how}${changed}.${link} <span class="ou-why">Up to date with ${shortSha(freshness.story_head)}</span>`;
  }

  /** What the line under the toolbar holds. */
  function lineView(freshness: Freshness | null) {
    const line = progressView();
    if (!freshness || freshness.state === 'n/a') {
      return line;
    }
    if (freshness.state === 'current') {
      return html`${updatedView(freshness) || html`<span class="ou-why">Up to date with ${shortSha(freshness.story_head)}</span>`}${line && ' '}${line}`;
    }
    if (freshness.state === 'unknown') {
      return html`${freshness.error && html`<span class="ou-why" title=${freshness.error}>Can't tell whether the story is up to date</span>`}${line}`;
    }
    const newer = freshness.newer;
    let what = 'the PR has newer commits';
    if (freshness.rewritten) {
      what = 'the PR was rebased or force-pushed since';
    } else if (newer != null) {
      what = `the PR has ${plural(newer, 'newer commit')}`;
    }
    const files = (freshness.changed_files || []).length;
    const changed = files
      ? ` (${plural(files, 'file')} changed${inChapters(freshness.chapters_touched || [])})`
      : '';
    const rebased =
      freshness.rewritten &&
      html`<span class="ou-why">It was rebased, so a re-tell is likely the better fit.</span>`;
    const label = (which: 'update' | 'retell', text: string, askedText: string) =>
      asked === which ? askedText : text;
    const update = html`<button class="ou-update" data-retell="0" title=${UPDATE_TITLE} disabled=${asking || !!asked} onClick=${() => ask(false)}>${label('update', 'Update (new commits)', 'Update asked for')}</button>`;
    const retell = html`<button class="ou-update" data-retell="1" title=${RETELL_TITLE} disabled=${asking || !!asked} onClick=${() => ask(true)}>${label('retell', 'Re-tell from scratch', 'Re-tell asked for')}</button>`;
    // no Update or Re-tell while a session is at work on the story: it would only queue a second request
    const buttons = line || (opts.requestUpdate && html`${update}${retell}${rebased}`);
    return html`Story is for ${shortSha(freshness.story_head)}; ${what}${changed}.${buttons}`;
  }

  /** The line under the toolbar. */
  function view() {
    const stale = !!fresh && fresh.state === 'stale';
    return html`<div class=${stale ? 'ou-fresh ou-stale' : 'ou-fresh'}>${lineView(fresh)}</div>`;
  }

  /** At the top of a "Since you read it" chapter: which commits it covers, and that the rest is as they read it. */
  function sinceModel(chapter: Chapter | null): SinceModel | null {
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
    let link: SinceModel['link'] = null;
    if (url && here) {
      link = { kind: 'here', all: `${data.pr.url}/changes` };
    } else if (url) {
      link = { kind: 'url', url, range };
    }
    return { what, range, rest, link };
  }

  function sinceView(since: SinceModel | null) {
    if (!since) {
      return null;
    }
    const { link } = since;
    const linkView =
      link && link.kind === 'here'
        ? html` You're on GitHub's diff of just these commits. <a href=${link.all}>All of the PR's changes</a>`
        : link &&
          html` <a href=${link.url} title=${`GitHub's Files changed for ${link.range} only`}>See just these commits' changes on GitHub</a>`;
    return html`<${Banner} tone="accent" class="ou-since"><b>${since.what}</b>, ${since.range}. This step shows only the files they touched.${since.rest}${linkView}</${Banner}>`;
  }

  return {
    get current() {
      return fresh;
    },
    refresh,
    render,
    setRequest,
    view,
    sinceModel,
    sinceView,
  };
}

export type FreshnessPart = ReturnType<typeof createFreshness>;
