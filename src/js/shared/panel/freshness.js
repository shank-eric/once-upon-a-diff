/*
 * Is the story up to date with the PR's latest commit (opts.freshness)? A
 * stale story says so under the toolbar, with Update and Re-tell buttons, and
 * marks the files and chapters that changed since. A story updated in place
 * says what the update brought in. And the banner at the top of a "Since you
 * read it" chapter, with a link to GitHub's diff of just its commits.
 *
 * rangeStepOf and rangeUrl have no DOM, so node tests can use them.
 */
import { escapeHtml } from '../util/html.js';
import { plural, shortSha } from '../util/text.js';
import { rangeOfPath } from '../util/github-paths.js';

export { rangeOfPath };

const sameSha = (first, second) =>
  !!first && !!second && (first.startsWith(second) || second.startsWith(first));

/** The step (1-based) of the "Since you read it" chapter for the range this page shows, or null. */
export function rangeStepOf(chapters, pathname) {
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
 * The link to GitHub's diff of just a chapter's commits. /files/<from>..<to> loads as is, logged in or out
 * (checked 2026-10-21); /changes/<from>..<to> redirects there when logged out.
 */
export const rangeUrl = (prUrl, since) =>
  prUrl && since ? `${String(prUrl).replace(/\/+$/, '')}/files/${since.from}..${since.to}` : null;

export function createFreshness(context) {
  const { story, opts, shell } = context;
  const { data } = story;
  const { $ } = shell;
  let fresh = null;

  async function refresh() {
    if (!opts.freshness) {
      return;
    }
    try {
      fresh = await opts.freshness();
    } catch (e) {
      fresh = { state: 'unknown', error: e && e.message };
    }
    render();
  }

  /** ", in chapter 1, chapter 3" for the chapters that list the changed files */
  const inChapters = (touched) =>
    touched.length ? `, in ${touched.map(story.chapterName).join(', ')}` : '';

  /** Marks the changed files in the file list and the chapters that list them in the step list. */
  function markChanged(files, chaptersTouched, fileTag, stepTag) {
    const changed = new Set(files || []);
    for (const item of shell.root.querySelectorAll('ul.prs-files > li[data-file]')) {
      if (changed.has(item.getAttribute('data-file'))) {
        item.querySelector('code').insertAdjacentHTML('afterend', fileTag);
      }
    }
    for (const item of shell.root.querySelectorAll('ol.prs-map li[data-n]')) {
      if ((chaptersTouched || []).includes(Number(item.getAttribute('data-n')))) {
        item.insertAdjacentHTML('beforeend', stepTag);
      }
    }
  }

  function wireUpdateButtons(box) {
    for (const button of box.querySelectorAll('.prs-update')) {
      button.onclick = async () => {
        const retell = button.getAttribute('data-retell') === '1';
        for (const other of box.querySelectorAll('.prs-update')) {
          other.disabled = true;
        }
        try {
          await opts.requestUpdate(fresh.story_head, { retell });
          button.textContent = retell ? 'Re-tell asked for' : 'Update asked for';
          shell.message(
            retell
              ? 'Asked for a new story from scratch. A Claude session picks it up from the inbox.'
              : 'Asked for a “Since you read it” chapter for the new commits. A Claude session picks it up from the inbox.',
          );
        } catch (e) {
          for (const other of box.querySelectorAll('.prs-update')) {
            other.disabled = false;
          }
          shell.message(`Couldn't ask for an update: ${e && e.message ? e.message : e}`);
        }
      };
    }
  }

  function render() {
    const box = $('.prs-fresh');
    for (const el of shell.root.querySelectorAll('.prs-changed, .prs-touched')) {
      el.remove();
    }
    box.classList.remove('prs-stale');
    if (!fresh || fresh.state === 'n/a') {
      box.innerHTML = '';
      return;
    }
    if (fresh.state === 'current') {
      box.innerHTML =
        updatedHtml(fresh) ||
        `<span class="prs-why">Up to date with ${escapeHtml(shortSha(fresh.story_head))}</span>`;
      markUpdated(fresh.updated);
      return;
    }
    if (fresh.state === 'unknown') {
      box.innerHTML = fresh.error
        ? `<span class="prs-why" title="${escapeHtml(fresh.error)}">Can't tell whether the story is up to date</span>`
        : '';
      return;
    }
    box.classList.add('prs-stale');
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
    const buttons = opts.requestUpdate
      ? `<button class="prs-update" data-retell="0" title="Adds a “Since you read it” chapter for the new commits, first, and keeps the chapters you read">Update (new commits)</button>` +
        `<button class="prs-update" data-retell="1" title="A whole new story at the latest commit, for a rebase or a big rework">Re-tell from scratch</button>` +
        (fresh.rewritten
          ? '<span class="prs-why">It was rebased, so a re-tell is likely the better fit.</span>'
          : '')
      : '';
    box.innerHTML = `Story is for ${escapeHtml(shortSha(fresh.story_head))}; ${what}${changed}.${buttons}`;
    wireUpdateButtons(box);
    // mark what changed since the story: the files, and the chapters that list them
    markChanged(
      fresh.changed_files,
      fresh.chapters_touched,
      '<span class="prs-changed" title="Changed in a commit after the one the story was told from">changed since story</span>',
      '<span class="prs-touched" title="A file here changed after the story was told">• changed since</span>',
    );
  }

  /**
   * A story updated in place (no "Since you read it" chapter for the update): say so at the top, with what the new
   * commits changed and a link to GitHub's diff of just them, so what's new stays apart from what they'd seen.
   */
  function updatedHtml(freshness) {
    const updated = freshness && freshness.updated;
    if (!updated) {
      return '';
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
    const range = `${escapeHtml(shortSha(updated.from))}..${escapeHtml(shortSha(updated.to))}`;
    return (
      `<b>${escapeHtml(commits)} since ${escapeHtml(shortSha(updated.from))}</b>: the story was ${how}${changed}.` +
      (url
        ? ` <a href="${escapeHtml(url)}" title="GitHub's Files changed for ${range} only">See just what's new on GitHub</a>`
        : '') +
      ` <span class="prs-why">Up to date with ${escapeHtml(shortSha(freshness.story_head))}</span>`
    );
  }

  function markUpdated(updated) {
    if (!updated) {
      return;
    }
    const range = `${escapeHtml(shortSha(updated.from))}..${escapeHtml(shortSha(updated.to))}`;
    markChanged(
      updated.changed_files,
      updated.chapters_touched,
      `<span class="prs-changed" title="Changed in ${range}, the commits the last update brought in">new since ${escapeHtml(shortSha(updated.from))}</span>`,
      `<span class="prs-touched" title="A file here changed in ${range}, the commits the last update brought in">• updated</span>`,
    );
  }

  /** At the top of a "Since you read it" chapter: which commits it covers, and that the rest is as they read it. */
  function sinceBanner(chapter) {
    if (!chapter || !chapter.since) {
      return '';
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
    const range = `${escapeHtml(shortSha(chapter.since.from))}..${escapeHtml(shortSha(chapter.since.to))}`;
    let link = '';
    if (url && here) {
      link = ` You're on GitHub's diff of just these commits. <a href="${escapeHtml(`${data.pr.url}/files`)}">All of the PR's changes</a>`;
    } else if (url) {
      link = ` <a href="${escapeHtml(url)}" title="GitHub's Files changed for ${range} only">See just these commits' changes on GitHub</a>`;
    }
    return `<div class="prs-since"><b>${escapeHtml(what)}</b>, ${range}. This step shows only the files they touched.${escapeHtml(rest)}${link}</div>`;
  }

  return {
    get current() {
      return fresh;
    },
    refresh,
    render,
    sinceBanner,
  };
}
