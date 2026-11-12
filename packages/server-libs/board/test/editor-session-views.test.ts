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
