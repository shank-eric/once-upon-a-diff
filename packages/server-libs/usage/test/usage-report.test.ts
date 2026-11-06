import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { buildReport, renderReport, sinceDay } from '../src/report.ts';
import { shaOf, toBase64, emptyBits } from '../src/lines.ts';
import { ROUTE_AREAS } from '../src/areas.ts';
import { ACTIONS } from '@once-upon-a-diff/terms/usage-actions';
import type { CoverageFile } from '../src/merge.ts';

const NOW = new Date('2026-11-05T14:00:00.000Z'); // 9 AM ET on the 5th

/** A tiny checkout with one backlog file and one file nothing loaded, and coverage for the first. */
function world(opts: { uncovered?: number[]; stale?: boolean } = {}) {
  const root = tmp('checkout');
  const home = tmp('home');
  const backlog = 'export const a = 1;\nexport function b() {\n  return 2;\n}\n';
  const unseen = 'export const never = 1;\n';
  mkdirSync(path.join(root, 'packages/server-libs/state/src/queues/backlog'), { recursive: true });
  mkdirSync(path.join(root, 'packages/server-libs/state/src/records/worktrees'), {
    recursive: true,
  });
  writeFileSync(path.join(root, 'packages/server-libs/state/src/queues/backlog/store.ts'), backlog);
  writeFileSync(
    path.join(root, 'packages/server-libs/state/src/records/worktrees/scan.ts'),
    unseen,
  );
  const bits = emptyBits(4);
  for (const line of opts.uncovered ?? [1, 2, 3]) {
    bits[0] |= 1 << line;
  }
  const coverage: CoverageFile = {
    since: '2026-11-04T14:00:00.000Z',
    updated: '2026-11-05T13:50:00.000Z',
    lastFlush: '2026-11-05T13:55:00.000Z',
    starts: 2,
    files: {
      'packages/server-libs/state/src/queues/backlog/store.ts': [
        {
          sha: opts.stale ? 'deadbeef' : shaOf(backlog),
          mode: 'function',
          lines: 4,
          uncovered: toBase64(bits),
          firstSeen: '2026-11-04T14:00:00.000Z',
          lastSeen: '2026-11-05T13:50:00.000Z',
          takes: 9,
          dayUncovered: { '2026-11-04': 4, '2026-11-05': (opts.uncovered ?? [1, 2, 3]).length },
        },
      ],
    },
  };
  writeJson(path.join(home, 'usage', 'coverage-bridge.json'), coverage);
  writeJson(path.join(home, 'usage', 'actions.json'), {
    since: '2026-11-04T14:00:00.000Z',
    updated: '2026-11-05T13:50:00.000Z',
    lastFlush: '2026-11-05T13:55:00.000Z',
    days: {
      '2026-11-04': {
        routes: { token: { boardBacklogAdd: 4, health: 90 } },
        ui: { board: { 'board.tab.switch': 2 } },
      },
      '2026-11-05': {
        routes: { board: { boardBacklogAdd: 1 } },
        ui: { board: { 'board.tab.switch': 1 } },
        unknownDropped: 3,
      },
    },
  });
  writeFileSync(
    path.join(home, 'usage', 'cli-runs.log'),
    '2026-11-04 backlog.list\n2026-11-04 agent.beat\n2026-11-05 backlog.add\n',
  );
  return { root, home };
}

test('a report on partial data says how much it has, and what has no evidence of use', () => {
  const { root, home } = world();
  const report = buildReport({ home, root, now: NOW });
  assert.equal(report.partial, true);
  assert.equal(report.from, '2026-11-04T14:00:00.000Z');
  assert.equal(report.cliRuns, 3);
  const backlog = report.areas.find((area) => area.area === 'Backlog')!;
  assert.equal(backlog.routeCalls, 5);
  assert.equal(backlog.commandRuns, 2);
  assert.deepEqual(
    backlog.routesZero.sort(),
    ['boardBacklogDrop', 'boardBacklogEdit', 'boardBacklogMove']
      .sort()
      .concat(['boardBacklogAssign', 'boardBacklogSomeday'])
      .sort(),
  );
  assert.equal(backlog.uncoveredLines, 3);
  assert.equal(backlog.codeLines, 4);
  const worktrees = report.areas.find((area) => area.area === 'Worktrees')!;
  assert.deepEqual(worktrees.neverLoaded, [
    'packages/server-libs/state/src/records/worktrees/scan.ts',
  ]);
  assert.ok(worktrees.routesZero.includes('boardWorktreeClean'));
  assert.ok(
    !report.areas.some((area) => area.routesZero.includes('health')),
    'polled routes are not evidence of non-use',
  );
  const text = renderReport(report);
  assert.match(text, /Window: 11\/4, 9:00 AM ET to 11\/5, 8:55 AM ET \(24 h of data\)/);
  assert.match(text, /PARTIAL: under a week of data/);
  assert.match(text, /Routes with no calls, 0 in 24 h/);
  assert.match(text, /3 unknown action name\(s\) dropped/);
  assert.match(text, /No earlier report to compare with/);
});

test('--since narrows the counts to a day and says coverage is still since the start', () => {
  const { root, home } = world();
  assert.equal(sinceDay('2026-11-05', undefined, NOW), '2026-11-05');
  assert.equal(sinceDay(undefined, '24h', NOW), '2026-11-04');
  assert.equal(sinceDay(undefined, '3d', NOW), '2026-11-02');
  assert.equal(sinceDay('yesterday', undefined, NOW), null);
  const report = buildReport({ home, root, now: NOW, since: '2026-11-05' });
  assert.equal(report.routes.boardBacklogAdd, 1);
  assert.equal(report.ui['board.tab.switch'], 1);
  assert.equal(report.cliRuns, 1);
  assert.equal(report.narrowed, true);
  assert.match(renderReport(report), /coverage is still since the start/);
});

test('since the last report: newly covered lines, first hits and the biggest movers', () => {
  const { root, home } = world();
  const first = buildReport({ home, root, now: NOW, save: true });
  assert.equal(first.since_last, null);
  assert.ok(existsSync(path.join(home, 'usage', 'last-report.json')));
  // time passes: the bridge covers two more lines, the board gets used, a never-used route is hit once
  const coverage = JSON.parse(
    readFileSync(path.join(home, 'usage', 'coverage-bridge.json'), 'utf8'),
  ) as CoverageFile;
  const entry = coverage.files['packages/server-libs/state/src/queues/backlog/store.ts'][0];
  entry.uncovered = toBase64(emptyBits(4));
  entry.dayUncovered['2026-11-06'] = 0;
  coverage.starts = 3;
  writeJson(path.join(home, 'usage', 'coverage-bridge.json'), coverage);
  const actions = JSON.parse(readFileSync(path.join(home, 'usage', 'actions.json'), 'utf8'));
  actions.days['2026-11-05'].routes.board.boardBacklogDrop = 2;
  actions.days['2026-11-05'].routes.board.boardBacklogAdd = 6;
  writeJson(path.join(home, 'usage', 'actions.json'), actions);
  const later = buildReport({ home, root, now: new Date('2026-11-06T14:00:00.000Z'), save: false });
  const since = later.since_last!;
  assert.equal(since.at, NOW.toISOString());
  assert.equal(since.newlyCoveredLines.Backlog, 3);
  assert.ok(since.firstHits.includes('route boardBacklogDrop'));
  assert.deepEqual(since.movers[0], { name: 'route boardBacklogAdd', delta: 5 });
  assert.equal(since.newRestarts, 1);
  const text = renderReport(later);
  assert.match(text, /Since the last report \(11\/5, 9:00 AM ET\)/);
  assert.match(text, /first hits on things that had none: .*boardBacklogDrop/);
  // --no-save leaves the snapshot alone, so the same report can be asked for again
  assert.equal(
    buildReport({ home, root, now: NOW, save: false }).since_last?.at,
    NOW.toISOString(),
  );
});

test('coverage on an older version of a file is used and marked, never trusted as the current one', () => {
  const { root, home } = world({ stale: true });
  const report = buildReport({ home, root, now: NOW });
  const file = report.files.find((one) => one.path.endsWith('backlog/store.ts'))!;
  assert.equal(file.stale, true);
  assert.match(renderReport(report), /older version of the file/);
});

test('with no data at all the report still runs and says so', () => {
  const root = tmp('checkout');
  const home = tmp('home');
  const report = buildReport({ home, root, now: NOW });
  assert.equal(report.partial, true);
  assert.equal(report.sources.bridge.lastFlush, null);
  assert.match(renderReport(report), /Sources: bridge no data/);
});

test('every area the actions and routes name exists in the report', () => {
  const { root, home } = world();
  const names = new Set(buildReport({ home, root, now: NOW }).areas.map((area) => area.area));
  for (const area of [
    ...Object.values(ROUTE_AREAS),
    ...Object.values(ACTIONS).map((action) => action.area),
  ]) {
    assert.ok(names.has(area), area);
  }
});

test('fix 5: only a full report moves the "since last report" baseline, not --since or --last', () => {
  const { root, home } = world();
  const saved = path.join(home, 'usage', 'last-report.json');
  const windowed = buildReport({ home, root, now: NOW, since: '2026-11-05', save: true });
  assert.equal(windowed.narrowed, true);
  assert.ok(!existsSync(saved), 'a windowed report saves nothing');
  assert.match(renderReport(windowed), /narrowed by --since is not saved/);

  buildReport({ home, root, now: NOW, save: true });
  const full = readFileSync(saved, 'utf8');
  buildReport({ home, root, now: NOW, since: '2026-11-05', save: true });
  assert.equal(readFileSync(saved, 'utf8'), full, 'and does not overwrite the full one');
});
