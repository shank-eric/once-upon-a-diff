import '@once-upon-a-diff/test-kit/env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { collectWorks } from '../src/stages/works.ts';
import { noPrWatcher } from '../src/stages/pr-watcher.ts';
import type { BacklogItem } from '@once-upon-a-diff/state/queues/backlog/types';
import type { BuildContext } from '../src/stages/types.ts';

const NOW = Date.parse('2026-11-20T15:00:00Z');
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60000).toISOString();

type Row = { id: string; kind: 'github' | 'local'; [key: string]: unknown };
const ctxOf = (rows: Row[], merged: Record<string, unknown> = {}) =>
  ({
    nowMs: NOW,
    now: new Date(NOW),
    review: noPrWatcher,
    builds: { pending: () => [] },
    stories: {
      home: tmp('landed-works-home'),
      list: () => rows,
      readState: (id: string, file: string, fallback: unknown) =>
        file === 'merged.json' && merged[id] ? merged[id] : fallback,
    },
  }) as unknown as BuildContext;

const landed = (over: Partial<BacklogItem>): BacklogItem =>
  ({
    id: 'bl_landed',
    title: 'landed',
    repo: 'acme/widgets',
    branch: 'feat/x',
    source: 'pr',
    pr: 7,
    landed_at: iso(10),
    ...over,
  }) as unknown as BacklogItem;

test('a landed card does not double the work of its branch that has no PR number', () => {
  const dir = tmp('landed-works-story');
  writeJson(path.join(dir, 'meta.json'), { kind: 'local', repo: 'acme/widgets' });
  const local = {
    id: 'local-x',
    kind: 'local' as const,
    title: 'x',
    branch: 'feat/x',
    repo_path: dir,
    dir,
    version: String(NOW - 60000),
  };
  const { works } = collectWorks(ctxOf([local]), [landed({})]);
  assert.equal(works.size, 1, [...works.keys()].join(', '));
});

test('a landed card does not move the merge time of a work merged earlier', () => {
  const story = {
    id: 'gh-7',
    kind: 'github' as const,
    repo: 'acme/widgets',
    number: 7,
    title: 'seven',
    head_ref: 'feat/x',
    version: String(NOW - 3600000),
    dir: tmp('landed-works-gh'),
  };
  const early = iso(30);
  const { works } = collectWorks(ctxOf([story], { 'gh-7': { why: 'merged', merged_at: early } }), [
    landed({ landed_at: iso(5) }),
  ]);
  assert.equal([...works.values()][0]?.mergedAt, early);
});
