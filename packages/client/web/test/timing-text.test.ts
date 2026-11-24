import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newPollLog,
  parseServerTiming,
  pollEnded,
  pollStarted,
  timingText,
} from '../public/board/header/timing-text.ts';

test("the bridge's Server-Timing header gives the build time and the load", () => {
  assert.deepEqual(parseServerTiming('build;dur=120, load;desc="2.31"'), {
    buildMs: 120,
    load: 2.31,
  });
  assert.deepEqual(parseServerTiming('build;dur=5'), { buildMs: 5, load: null });
});

test('no build entry means no bridge timing', () => {
  assert.equal(parseServerTiming(null), null);
  assert.equal(parseServerTiming('cache;desc=hit'), null);
});

test('the tooltip names the build, the load, the request and the gap between polls', () => {
  assert.equal(
    timingText({ buildMs: 1800, load: 4.5 }, { gapMs: 3100, tookMs: 140 }),
    'bridge build 1.8 s · load 4.50 · request 140 ms · 3.1 s between polls',
  );
});

test('the tooltip leaves out what is not known yet', () => {
  assert.equal(timingText(null, { gapMs: null, tookMs: null }), '');
  assert.equal(timingText(null, { gapMs: null, tookMs: 90 }), 'request 90 ms');
});

test('the poll gap runs from the end of one request to the start of the next, not counting the request again', () => {
  const log = newPollLog();
  // a 10 s request, then the poll timer's 3 s
  pollStarted(log, 0);
  assert.equal(log.gapMs, null);
  pollEnded(log, 0, 10_000);
  pollStarted(log, 13_000);
  assert.equal(log.gapMs, 3000);
  pollEnded(log, 13_000, 13_150);
  assert.equal(log.tookMs, 150);
  assert.equal(timingText(null, log), 'request 150 ms · 3.0 s between polls');
});

test('time the tab spent hidden is marked in the gap, and only for the poll after it', () => {
  const log = newPollLog();
  pollStarted(log, 0);
  pollEnded(log, 0, 100);
  log.hiddenSince = true; // the tab was hidden
  pollStarted(log, 45_100);
  assert.equal(log.gapMs, 45_000);
  assert.match(timingText(null, log), /45\.0 s between polls \(tab was hidden\)/);
  pollEnded(log, 45_100, 45_200);
  pollStarted(log, 48_200);
  assert.equal(log.hiddenInGap, false);
  assert.equal(timingText(null, log), 'request 100 ms · 3.0 s between polls');
});
