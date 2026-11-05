/*
 * The races in docs/state-map.md §7 (items 1 and 2): builds.json, fixes.json and notes.json are rewritten by the
 * bridge and by CLI processes at once. Each cross-process test starts its children together (they wait for a `go`
 * file) and checks that no write was lost and no request was handed out twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmp, githubStory, writeJson } from './helpers.ts';
import { Builds } from '../src/services/inbox/builds.ts';
import { readHanded } from '../src/services/inbox/conversation.ts';
import { fixesView, readFixes, readNotes } from '../src/services/inbox/fixes.ts';
import { StoryStore } from '../src/services/stories/store.ts';
import type { FixRequest } from '../src/services/inbox/fixes.ts';
import type { LocalNote } from '@once-upon-a-diff/contracts/types';
import type { StoryMeta } from '../src/services/stories/types.ts';

const STORY = 'acme-widgets-7';
/** The longest a race may take, on a loaded machine. */
const RACE_MS = 60_000;
const src = (file: string) => JSON.stringify(path.resolve(import.meta.dirname, '../src', file));

/** The story as the fix functions take it. */
const story = {
  id: STORY,
  meta: { kind: 'github', repo: 'acme/widgets', number: 7 } as StoryMeta,
  ref: { story: STORY, kind: 'github' as const, repo: 'acme/widgets', title: 'Add widgets' },
};

/**
 * Runs `body` in one child per argument list, all at once: each says it's ready, then waits for the `go` file, so
 * their writes overlap. Resolves with each child's stdout.
 */
async function race(body: string, argsList: string[][]): Promise<string[]> {
  const dir = tmp('race');
  const goFile = path.join(dir, 'go');
  const script = path.join(dir, 'child.ts');
  writeFileSync(
    script,
    `import { existsSync } from 'node:fs';
import { Builds } from ${src('services/inbox/builds.ts')};
import { addNote, fixesToHand } from ${src('services/inbox/fixes.ts')};
import { noteHanded, routeQuestions } from ${src('services/inbox/conversation.ts')};
import { StoryStore } from ${src('services/stories/store.ts')};
const [go, ...args] = process.argv.slice(2);
process.stderr.write('ready\\n');
while (!existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
${body}
`,
  );
  let ready = 0;
  let timedOut = false;
  const procs = argsList.map((args) =>
    spawn(process.execPath, [script, goFile, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }),
  );
  const children = procs.map((child) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => {
      err += chunk;
      if (String(chunk).includes('ready') && ++ready === argsList.length) {
        writeFileSync(goFile, '');
      }
    });
    return new Promise<string>((resolve, reject) =>
      child.on('close', (code) =>
        code === 0
          ? resolve(out)
          : reject(
              new Error(
                timedOut ? `the race took over ${RACE_MS} ms` : `child failed (${code}): ${err}`,
              ),
            ),
      ),
    );
  });
  // a child that dies before it's ready, or a race that never ends, fails the test instead of hanging the file
  const stopAll = () => procs.forEach((child) => child.kill('SIGKILL'));
  const timer = setTimeout(() => {
    timedOut = true;
    stopAll();
  }, RACE_MS);
  try {
    return await Promise.all(children);
  } catch (err) {
    stopAll();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Every id handed out, across the children's printed JSON lists. */
const handed = (outs: string[]) => outs.flatMap((out) => JSON.parse(out) as string[]);

test('race 1: two processes asking for builds at once keep every request', async () => {
  const home = tmp('home');
  await race(
    `const builds = new Builds(args[0]);
for (let n = Number(args[1]); n < Number(args[1]) + 60; n++) builds.request({ repo: 'acme/widgets', number: n });`,
    [
      [home, '1'],
      [home, '101'],
    ],
  );
  assert.equal(Object.keys(new Builds(home).all()).length, 120, 'every request survived');
});

test("race 1: a wait's claims survive requests filed at the same time", async () => {
  const home = tmp('home');
  const done = path.join(home, 'filed');
  const [taken] = await race(
    `const builds = new Builds(args[0]);
if (args[1] === 'wait') {
  const ids = [];
  for (let last = false; ; ) {
    last = existsSync(args[2]);
    ids.push(...builds.toHand('a', { live: [] }).map((entry) => entry.id));
    if (last) break;
  }
  process.stdout.write(JSON.stringify(ids));
} else {
  for (let n = 1; n <= 80; n++) builds.request({ repo: 'acme/widgets', number: n });
  (await import('node:fs')).writeFileSync(args[2], '');
}`,
    [
      [home, 'wait', done],
      [home, 'file', done],
    ],
  );
  const all = new Builds(home).all();
  assert.equal(Object.keys(all).length, 80, 'every request survived');
  const ids = JSON.parse(taken) as string[];
  assert.equal(new Set(ids).size, ids.length, 'no request handed out twice');
  const byId = new Map(Object.values(all).map((build) => [build.id, build]));
  const lost = ids.filter((id) => byId.get(id)?.claimed_by !== 'a');
  assert.deepEqual(lost, [], 'every claim the wait made is in the file');
});

test('race 1: four waits at once hand each queued build to one of them', async () => {
  const home = tmp('home');
  const builds = new Builds(home);
  for (let num = 1; num <= 40; num++) {
    builds.request({ repo: 'acme/widgets', number: num });
  }
  const outs = await race(
    `process.stdout.write(JSON.stringify(new Builds(args[0]).toHand(args[1], { live: [] }).map((entry) => entry.id)));`,
    [1, 2, 3, 4].map((num) => [home, `c${num}`]),
  );
  const ids = handed(outs);
  assert.equal(new Set(ids).size, ids.length, 'no build handed out twice');
  assert.equal(ids.length, 40, 'every build handed out');
});

test('race 2: notes added by two processes at once all survive', async () => {
  const home = tmp('home');
  githubStory(path.join(home, STORY));
  await race(
    `const store = new StoryStore({ home: args[0] });
const story = ${JSON.stringify(story)};
for (let n = 0; n < 50; n++) addNote(args[0], store, story, { path: 'src/a.js', line: n + 1, body: args[1] + n });`,
    [
      [home, 'a'],
      [home, 'b'],
    ],
  );
  assert.equal(readNotes(new StoryStore({ home }), STORY).length, 100, 'every note survived');
});

test('race 2: four waits at once hand each fix request to one of them', async () => {
  const home = tmp('home');
  const all: Record<string, FixRequest> = {};
  for (let num = 1; num <= 20; num++) {
    const id = `f_${num}`;
    all[id] = {
      id,
      story: STORY,
      repo: 'acme/widgets',
      kind: 'github',
      title: null,
      url: null,
      branch: null,
      checkout: null,
      notes: [],
      to: null,
      requested_at: new Date(Date.now() - num * 1000).toISOString(),
      status: 'pending',
    };
  }
  writeJson(path.join(home, 'fixes.json'), all);
  const outs = await race(
    `process.stdout.write(JSON.stringify(fixesToHand(args[0], args[1], {}, { live: [] }).map((entry) => entry.id)));`,
    [1, 2, 3, 4].map((num) => [home, `c${num}`]),
  );
  const ids = handed(outs);
  assert.equal(new Set(ids).size, ids.length, 'no fix request handed out twice');
  assert.equal(ids.length, 20, 'every fix request handed out');
});

test('race 3: two waits on one repo never take the same question', async () => {
  const home = tmp('home');
  // each wait takes the repo's questions one at a time, as it hears them, and notes them handed, as `wait` does
  const outs = await race(
    `const ids = [];
for (let n = 1; n <= 40; n++) {
  const { take } = routeQuestions(args[0], args[1], { repo: 'acme/widgets' }, [{ id: 'q_' + n, story: '${STORY}' }], { live: [] });
  noteHanded(args[0], take.map((question) => question.id), args[1]);
  ids.push(...take.map((question) => question.id));
}
process.stdout.write(JSON.stringify(ids));`,
    [
      [home, 'repo-a'],
      [home, 'repo-b'],
    ],
  );
  const ids = handed(outs);
  assert.equal(new Set(ids).size, ids.length, 'no question handed to both waits');
  assert.equal(ids.length, 40, 'every question handed out');
  const owners = readHanded(home);
  const lost = ['repo-a', 'repo-b'].flatMap((consumer, num) =>
    (JSON.parse(outs[num]) as string[]).filter((id) => owners[id]?.consumer !== consumer),
  );
  assert.deepEqual(lost, [], 'handed.json names the wait that took each question');
});

/** A note as notes.json keeps it, with the marks given. */
const note = (id: string, marks: Partial<LocalNote> = {}): LocalNote => ({
  id,
  at: '2026-11-04T10:00:00.000Z',
  path: 'src/a.js',
  side: 'R',
  line: 1,
  body: id,
  done: false,
  ...marks,
});

/** A fix request for the story, listing the notes given. */
const request = (id: string, notes: string[], fields: Partial<FixRequest>): FixRequest => ({
  id,
  story: STORY,
  repo: 'acme/widgets',
  kind: 'github',
  title: null,
  url: null,
  branch: null,
  checkout: null,
  notes: notes.map((noteId) => ({
    id: noteId,
    path: 'src/a.js',
    side: 'R',
    line: 1,
    body: noteId,
    chapter: null,
    from_draft: false,
  })),
  to: 'api-10',
  requested_at: '2026-11-04T10:01:00.000Z',
  status: 'pending',
  ...fields,
});

test('race 2: a crash between the two writes never leaves a note stuck', () => {
  const home = tmp('home');
  githubStory(path.join(home, STORY));
  const store = new StoryStore({ home });
  // n1: sent to a request that never made it into fixes.json (an old home, or a crash before the request was saved)
  // n2: in a pending request, but notes.json was not written yet
  // n3: fixed by a done request, but notes.json still says sent
  // n4: in a taken-back request, notes.json still says sent
  store.writeState(STORY, 'notes.json', [
    note('n1', { sent: { request: 'f_gone', to: 'api-10', at: '2026-11-04T10:01:00.000Z' } }),
    note('n2'),
    note('n3', { sent: { request: 'f_done', to: 'api-10', at: '2026-11-04T10:01:00.000Z' } }),
    note('n4', { sent: { request: 'f_back', to: 'api-10', at: '2026-11-04T10:01:00.000Z' } }),
  ]);
  writeJson(path.join(home, 'fixes.json'), {
    f_sent: request('f_sent', ['n2'], {}),
    f_done: request('f_done', ['n3'], {
      status: 'done',
      done_at: '2026-11-04T10:05:00.000Z',
      sha: 'abc1234',
      fixed: ['n3'],
      by: 'api-10',
    }),
    f_back: request('f_back', ['n4'], {
      status: 'taken_back',
      done_at: '2026-11-04T10:06:00.000Z',
    }),
  });
  const view = fixesView(home, store, story, []);
  const byId = new Map(view.notes.map((one) => [one.id, one]));
  assert.equal(byId.get('n1')!.state, 'draft', 'a note sent to a missing request is a draft again');
  assert.match(byId.get('n1')!.returned!.why ?? '', /lost/);
  assert.equal(byId.get('n2')!.state, 'sent');
  assert.equal(byId.get('n2')!.sent!.request, 'f_sent');
  assert.equal(byId.get('n3')!.state, 'fixed');
  assert.equal(byId.get('n3')!.fixed!.sha, 'abc1234');
  assert.equal(byId.get('n3')!.done, true);
  assert.equal(byId.get('n4')!.state, 'draft');
  assert.equal(byId.get('n4')!.returned!.why, 'taken back');
  // and the mend is saved, so the story's own data (the pulse) agrees
  const saved = new Map(readNotes(store, STORY).map((one) => [one.id, one]));
  assert.equal(saved.get('n1')!.sent, undefined);
  assert.equal(saved.get('n2')!.sent!.request, 'f_sent');
  assert.ok(existsSync(path.join(home, 'fixes.json')));
  assert.equal(
    readFixes(home).f_sent.status,
    'pending',
    'fixes.json is the record and is left alone',
  );
});
