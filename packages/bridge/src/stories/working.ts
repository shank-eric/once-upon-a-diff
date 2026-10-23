// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/**
 * "Being changed": a Claude session tells the bridge which of a story's files it's changing (`once-upon working`),
 * and the panel dims them, and the chapters that tell them, until it's done.
 *
 *   <home>/state/<story id>/working.json  {marks: {<consumer>: {consumer, files: [{path, ranges: [[start, end]]}],
 *                                          request, started_at, at}}, done: [{consumer, sha, files, at}]}
 *
 * A mark lasts until its session clears it (`working --done`, or `fixed`), and expires when the session goes quiet:
 * no `working` call for MARK_FRESH_MS, or its listener (the wait of the same consumer) stopped beating.
 */
import { ID_RE } from './meta.ts';
import { listeners } from '../listeners/listeners.ts';
import { readJson, writeJsonAtomic } from '../util/json-file.ts';
import { stateFile } from '../config/settings.ts';

export const MARK_FRESH_MS = 30 * 60 * 1000;
const DONE_KEPT = 5;
const MAX_FILES = 200;

const workingFile = (home, story) => stateFile(home, story, 'working.json');

function readWorking(home, story) {
  if (!ID_RE.test(String(story || ''))) {
    return { marks: {}, done: [] };
  }
  const saved = readJson(workingFile(home, story), {}) || {};
  return { marks: saved.marks || {}, done: saved.done || [] };
}

function saveWorking(home, story, working) {
  writeJsonAtomic(workingFile(home, story), working);
}

/**
 * `a.js,b.js:10-40,b.js:90` as [{path, ranges}]: files split on commas, each with an optional line or range after a
 * colon. A file named twice keeps every range.
 */
export function parseFiles(spec) {
  const byPath = new Map();
  for (const part of String(spec || '').split(',')) {
    const match = /^\s*(.+?)(?::(\d+)(?:-(\d+))?)?\s*$/.exec(part);
    if (!match) {
      continue;
    }
    const rel = match[1].replace(/^\.\//, '');
    if (!byPath.has(rel)) {
      byPath.set(rel, { path: rel, ranges: [] });
    }
    if (match[2]) {
      const start = Number(match[2]);
      const end = match[3] ? Math.max(start, Number(match[3])) : start;
      byPath.get(rel).ranges.push([start, end]);
    }
  }
  return [...byPath.values()].slice(0, MAX_FILES);
}

/**
 * Is this mark still standing? Not when it's older than MARK_FRESH_MS, nor when its session's listener has gone: it
 * beat after the mark was made and isn't live now. A listener of the same name that went quiet before the mark
 * (an old wait) doesn't count.
 */
export function markLive(mark, beats, now = Date.now()) {
  if (!(now - Date.parse(mark.at) < MARK_FRESH_MS)) {
    return false;
  }
  const listener = beats.find((beat) => beat.consumer === mark.consumer);
  const gone = listener && !listener.live && Date.parse(listener.at) >= Date.parse(mark.started_at);
  return !gone;
}

/**
 * Says `consumer` is changing these files of the story (replacing what it said before), or, with no files, that
 * it's still at it (a heartbeat). Returns the mark.
 */
export function setMark(home, story, consumer, { files = null, request = null } = {}) {
  const working = readWorking(home, story);
  const now = new Date().toISOString();
  const before = working.marks[consumer];
  if (!files && !before) {
    throw new Error(
      `${consumer} has no "being changed" mark on ${story}; say which files with --files`,
    );
  }
  working.marks[consumer] = {
    consumer,
    files: files || before.files,
    request: request || (before && before.request) || null,
    started_at: (before && before.started_at) || now,
    at: now,
  };
  saveWorking(home, story, working);
  return working.marks[consumer];
}

/**
 * Clears `consumer`'s mark, with the commit it ended in. With no mark of its own and exactly one on the story, that
 * one is cleared. Returns the cleared mark, or null when there was none.
 */
export function clearMark(home, story, consumer, { sha = null } = {}) {
  const working = readWorking(home, story);
  let key = consumer in working.marks ? consumer : null;
  if (!key && Object.keys(working.marks).length === 1) {
    key = Object.keys(working.marks)[0];
  }
  if (!key) {
    return null;
  }
  const mark = working.marks[key];
  delete working.marks[key];
  const clearedAt = new Date().toISOString();
  working.done = [
    { consumer: mark.consumer, sha, files: mark.files, at: clearedAt },
    ...working.done,
  ].slice(0, DONE_KEPT);
  saveWorking(home, story, working);
  return mark;
}

/** The story's standing marks, oldest first, and the last one cleared: {marks, last}. */
export function workingOf(home, story, { beats = null, now = Date.now() } = {}) {
  const working = readWorking(home, story);
  const known = beats || listeners(home, now);
  const marks = Object.values(working.marks)
    .filter((mark) => markLive(mark, known, now))
    .sort((first, second) => String(first.started_at).localeCompare(second.started_at));
  return { marks, last: working.done[0] || null };
}
