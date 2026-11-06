/*
 * A guard against a test file that leaves something running. node --test starts one process per file and waits for it to
 * exit, and a ref'd timer (a poll's keepalive, an overlay's tick, a setInterval), a listening server, an open socket, a child
 * process or a file watcher keeps that process alive once its tests are done: for ever when a timer re-arms itself, and as an
 * orphan if the run's parent is killed. Called once in a file (installDom, and the test-kit's env, files and git helpers do
 * it, so every package's tests that use them have it, in a bare `node --test file` too), it fails the file when no test has
 * run for IDLE_MS and one of those is still live: the process names what (`1 Timeout, 1 TCPServerWrap`) and exits with code 1,
 * so the leak is a failed run and not a hang. Timers that finish inside IDLE_MS (a re-render's 5 ms tick, a label that resets
 * in a second) are over by then; unref'd handles and fake timers (mock.timers) are not listed and pass, and the process's own
 * stdio pipes are not on the list. Fix a failure by tearing down what started it: stop the poll, unmount the app, flush the
 * usage counter, clear the interval, close the server, kill the child.
 *
 * IDLE_MS is as long as the test scripts' --test-timeout, so a slow teardown that is still inside it is not mistaken for a
 * leak (time in before/after hooks and in the file's top-level code between awaited tests counts as idle, as the runner gives
 * no sign of them). The watch is an unref'd interval of its own, so it only runs while something else keeps the process up.
 * The tests' end is told by beforeEach and afterEach, not an `after` hook: with `await test(...)` at the top level, the
 * root's `after` hooks run once the first test is done.
 */
import { afterEach, beforeEach } from 'node:test';
// node's own timers and clock: a test file may replace the global ones (the board page's test does, the panel's freezes Date)
import { setInterval } from 'node:timers';
import { performance } from 'node:perf_hooks';

/** How long no test may have run before a live handle counts as left running. */
const IDLE_MS = 60_000;

/** The kinds of handle that keep a process up and that a test can leave behind (the stdio pipes are always there, and not on this list). */
const LEAKS = new Set([
  'Timeout',
  'TCPServerWrap',
  'TCPSocketWrap',
  'UDPWrap',
  'ProcessWrap',
  'FSEventWrap',
]);

/** What is live that would keep the process up, by kind: `1 Timeout, 2 TCPSocketWrap`. */
function liveHandles(): string {
  const counts = new Map<string, number>();
  for (const name of process.getActiveResourcesInfo()) {
    if (LEAKS.has(name)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts].map(([name, count]) => `${count} ${name}`).join(', ');
}

let guarded = false;

export function assertNoLiveTimers(): void {
  if (guarded) {
    return;
  }
  guarded = true;
  let running = 0;
  let idleSince: number | null = null;
  beforeEach(() => {
    running++;
  });
  afterEach(() => {
    running--;
    idleSince = performance.now();
  });
  setInterval(() => {
    if (running > 0 || idleSince === null || performance.now() - idleSince < IDLE_MS) {
      return;
    }
    // the watch's own interval is unref'd, so it is not listed
    const live = liveHandles();
    if (live) {
      process.stderr.write(
        `\nStill live ${IDLE_MS / 1000} s after the last test ended, so the process would not exit: ${live}. Tear down what started them in this file (stop the poll, unmount the app, flush the usage counter, clear the interval, close the server, kill the child).\n`,
      );
      process.exit(1);
    }
  }, 500).unref();
}
