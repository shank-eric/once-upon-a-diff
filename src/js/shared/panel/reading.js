/*
 * What the reviewer has read: a chapter they stayed on for READ_MS (counted
 * while the tab shows), or ticked every file of, or (inferred) one whose files
 * the page already had all Viewed. Each goes to opts.onRead once per panel.
 * And the bridge's GET /read: the chapters that changed after they read them
 * (marks.js draws those) and the drafts a newer commit made stale.
 *
 * READ_MS, inferReadSteps and readStepsOf have no DOM, so node tests can use them.
 */
import { chapterKeyOf } from './story-model.js';

export const READ_MS = 30000;

/**
 * Chapters they reviewed before the panel tracked reads (or with the panel closed): every file the chapter marks
 * viewed was already Viewed the first time this page could see all of them, and read.json has no record of it.
 * Only that first look counts, so ticking a later chapter's files while reading an earlier one doesn't read it.
 * @param {{due: number, viewed: number, unknown: string[], noToggle: boolean}[]} progress progressOf() per step
 * @param {object|null} readInfo the bridge's GET /read; nothing is inferred until it has loaded
 * @param {Map<number, boolean>} firstLook step -> complete at the first look; filled in here
 * @returns {number[]} the steps to record as read
 */
export function inferReadSteps(chapters, progress, readInfo, firstLook) {
  if (!readInfo || !readInfo.reads) {
    return [];
  }
  const out = [];
  progress.forEach((stepProgress, index) => {
    const step = index + 1;
    if (
      firstLook.has(step) ||
      !stepProgress ||
      !stepProgress.due ||
      stepProgress.noToggle ||
      stepProgress.unknown.length
    ) {
      return; // not loaded on the page yet: look again later
    }
    const complete = stepProgress.viewed === stepProgress.due;
    firstLook.set(step, complete);
    if (complete && !readInfo.reads[chapterKeyOf(chapters[index])]) {
      out.push(step);
    }
  });
  return out;
}

/**
 * The steps whose chapter they've read (read.json has its key) and that haven't changed since they read them. A file
 * such a chapter finishes isn't "viewed early" from an earlier chapter: they've been through it already.
 * @param {object|null} readInfo the bridge's GET /read: {reads, changed: [{step}]}
 */
export function readStepsOf(chapters, readInfo) {
  const reads = (readInfo && readInfo.reads) || {};
  const changed = new Set(((readInfo && readInfo.changed) || []).map((change) => change.step));
  return new Set(
    chapters
      .map((chapter, index) =>
        reads[chapterKeyOf(chapter)] && !changed.has(index + 1) ? index + 1 : 0,
      )
      .filter(Boolean),
  );
}

export function createReading(context) {
  const { story, state, opts } = context;
  const { data } = story;
  const readAfterMs = Number.isFinite(opts.readAfterMs) ? opts.readAfterMs : READ_MS;
  const sent = new Set(); // "<key> <reason>": each at most once per panel
  const completeSeen = new Map(); // chapter -> were all its files viewed when last looked at
  const firstLook = new Map(); // chapter -> were all its files already viewed the first time the page showed them all (inferReadSteps)
  let clock = { step: 0, ms: 0, from: 0 };
  let info = null; // the bridge's GET /read
  const showing = () => document.visibilityState === 'visible';

  function start() {
    clock = { step: state.n, ms: 0, from: showing() ? Date.now() : 0 };
  }
  const elapsed = () => clock.ms + (clock.from ? Date.now() - clock.from : 0);

  function send(step, reason) {
    const chapter = data.chapters[step - 1];
    if (!opts.onRead || !chapter) {
      return;
    }
    const key = chapterKeyOf(chapter);
    const once = `${key} ${reason}`;
    if (sent.has(once)) {
      return;
    }
    sent.add(once);
    // the bridge asks gh when the panel doesn't know
    const fresh = context.freshness.current;
    const head = data.kind === 'local' ? null : (fresh && fresh.current_head) || null;
    const seconds =
      reason !== 'inferred' && clock.step === step ? Math.round(elapsed() / 1000) : null;
    try {
      Promise.resolve(
        opts.onRead({ chapter: key, step, title: chapter.title, reason, seconds, head_sha: head }),
      ).then(refresh, () => sent.delete(once));
    } catch {
      sent.delete(once);
    }
  }

  /** Leaving the step: it counts as read once they've been on it readAfterMs. */
  function leave() {
    if (clock.step > 0 && elapsed() >= readAfterMs) {
      send(clock.step, 'time');
    }
  }

  // switching tabs stops the clock, and counts as leaving
  const onVisibility = () => {
    if (showing()) {
      if (!clock.from) {
        clock.from = Date.now();
      }
      return;
    }
    clock.ms = elapsed();
    clock.from = 0;
    leave();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', leave);

  /** The viewed tracker's progress per chapter: a chapter complete at the page's first look counts as read. */
  function noteProgress(progress) {
    for (const step of inferReadSteps(data.chapters, progress, info, firstLook)) {
      send(step, 'inferred');
    }
  }
  /** Ticking the last of a chapter's files counts as reading it, when it's a change seen here. */
  function noteComplete(step, complete) {
    if (complete && completeSeen.get(step) === false) {
      send(step, 'viewed');
    }
    completeSeen.set(step, complete);
  }

  // ---------- chapters they read that changed after they read them (the bridge compares the commit they read them at with the story's)
  async function refresh() {
    if (!opts.reads) {
      return;
    }
    try {
      info = await opts.reads();
    } catch {
      return; // the bridge may be down; the marks just don't show
    }
    context.marks.render();
    context.viewed.render(); // "viewed early" depends on which chapters they've read
    context.drafts.render();
  }
  /** A drafted comment on a line a newer commit changed after they read the chapter. */
  const isStaleDraft = (step, index) =>
    !!info &&
    (info.stale_comments || []).some((comment) => comment.step === step && comment.index === index);

  function destroy() {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', leave);
  }

  return {
    get info() {
      return info;
    },
    start,
    leave,
    noteProgress,
    noteComplete,
    refresh,
    isStaleDraft,
    destroy,
  };
}
