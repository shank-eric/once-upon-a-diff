import { test } from 'node:test';
import assert from 'node:assert/strict';
import '@once-upon-a-diff/test-kit/env';
import { markListening } from '../src/stages/listeners.ts';
import type { BuildContext } from '../src/stages/types.ts';
import type { BoardCard, BoardSession } from '@once-upon-a-diff/contracts/types';

const ctx = {
  home: '/tmp/x',
  nowMs: 0,
  review: { branchPr: () => null },
} as unknown as BuildContext;

test("an idle editor session is known by id, so its author's Build story is not 'session busy'", () => {
  const view = {
    id: 'ed1',
    status: 'idle',
    title: 'editor',
    focus: null,
  } as unknown as BoardSession;
  const card = {
    id: 'a:x',
    kind: 'agent',
    column: 'working',
    sessions: [],
    agents: [],
    focus_session: 'ed1',
    can_focus: true,
    review: { branch: 'feat-x', path: '/tmp/wt/feat-x' },
  } as unknown as BoardCard;
  const { sessionViews } = markListening(ctx, [card], {
    waits: [],
    parents: new Map(),
    sessionByPid: new Map(),
    quietViews: [],
    busyListeners: new Set(),
    blankViews: [],
    editorViews: [{ lane: 'x', view }],
    pin: null,
    repoBySession: new Map(),
  });
  assert.equal(sessionViews.get('ed1'), view);
  assert.equal(card.build?.blocked, null);
  assert.equal(card.build?.session, 'ed1');
});

test("a finished author's card in Ready to ship (pushed, no PR) keeps its Build story, a done card does not", () => {
  const view = {
    id: 'ed1',
    status: 'idle',
    title: 'editor',
    focus: null,
  } as unknown as BoardSession;
  const make = (column: string) =>
    ({
      id: `a:${column}`,
      kind: 'agent',
      column,
      sessions: [],
      agents: [],
      focus_session: 'ed1',
      can_focus: true,
      review: { branch: 'feat-x', path: '/tmp/wt/feat-x' },
    }) as unknown as BoardCard;
  const ship = make('ship');
  const done = make('done');
  markListening(ctx, [ship, done], {
    waits: [],
    parents: new Map(),
    sessionByPid: new Map(),
    quietViews: [],
    busyListeners: new Set(),
    blankViews: [],
    editorViews: [{ lane: 'x', view }],
    pin: null,
    repoBySession: new Map(),
  });
  assert.equal(ship.build?.session, 'ed1');
  assert.equal(ship.build?.blocked, null);
  assert.ok(!done.build);
});
