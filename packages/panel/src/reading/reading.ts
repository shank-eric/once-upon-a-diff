/*
 * What the reviewer has read: a chapter they stayed on for READ_MS (counted
 * while the tab shows), or ticked every file of, or (inferred) one whose files
 * the page already had all Viewed. Each goes to opts.onRead once per panel.
 * And the bridge's GET /read: the chapters that changed after they read them
 * (marks.js draws those) and the drafts a newer commit made stale.
 *
 * inferReadSteps and viewedEarlyCheck, which have no DOM, are in read-checks.ts.
 */
import { chapterKeyOf } from '@once-upon-a-diff/domain/chapters';
import type { ReadEvent, ReadInfo } from '@once-upon-a-diff/contracts/types';
import { inferReadSteps } from './read-checks.ts';
import type { StepProgress } from './read-checks.ts';
import type { PanelContext } from '../host/context.ts';

export const READ_MS = 30000;

/**
 * Each build of a story that's told chapter by chapter remounts the panel. So the time on the step isn't lost to it,
 * the clock goes here when a panel is destroyed (module state outlives the panel in the page) and the next panel for the
 * same story, on the same step, picks it up if that happens within CARRY_MS.
 */
const CARRY_MS = 5 * 60 * 1000;
let carriedClock: { story: string; step: number; ms: number; at: number } | null = null;

export function createReading(context: PanelContext) {
  const { story, state, opts } = context;
  const { data } = story;
  const sent = new Set(); // "<key> <reason>": each at most once per panel
  const completeSeen = new Map(); // chapter -> were all its files viewed when last looked at
  const firstLook = new Map(); // chapter -> were all its files already viewed the first time the page showed them all (inferReadSteps)
  let clock = { step: 0, ms: 0, from: 0 };
  let resumeClock = carriedClock && carriedClock.story === data.id ? carriedClock : null;
  carriedClock = null;
  let info: ReadInfo | null = null; // the bridge's GET /read
  const showing = () => document.visibilityState === 'visible';

  function start() {
    const resume =
      resumeClock && resumeClock.step === state.n && Date.now() - resumeClock.at < CARRY_MS
        ? resumeClock.ms
        : 0;
    resumeClock = null; // only the first start after a remount: moving to another step begins a new clock
    clock = { step: state.n, ms: resume, from: showing() ? Date.now() : 0 };
  }
  const elapsed = () => clock.ms + (clock.from ? Date.now() - clock.from : 0);

  function send(step: number, reason: ReadEvent['reason']) {
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

  /** Leaving the step: it counts as read once they've been on it READ_MS. */
  function leave() {
    // a chapter still being written isn't read by staring at its skeleton
    if (clock.step > 0 && elapsed() >= READ_MS && !data.chapters[clock.step - 1]?.unwritten) {
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
  function noteProgress(progress: StepProgress[]) {
    for (const step of inferReadSteps(data.chapters, progress, info, firstLook)) {
      send(step, 'inferred');
    }
  }
  /** Ticking the last of a chapter's files counts as reading it, when it's a change seen here. */
  function noteComplete(step: number, complete: boolean) {
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
  const isStaleDraft = (step: number, index: number) =>
    !!info &&
    (info.stale_comments || []).some((comment) => comment.step === step && comment.index === index);

  function destroy() {
    if (clock.step > 0 && elapsed() < READ_MS) {
      carriedClock = { story: data.id, step: clock.step, ms: elapsed(), at: Date.now() };
    }
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

export type Reading = ReturnType<typeof createReading>;
