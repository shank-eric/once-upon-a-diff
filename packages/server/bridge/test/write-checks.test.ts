import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  git,
  githubStory,
  localRepo,
  runCli,
  startBridge,
  tmp,
  writeJson,
  TOKEN,
  type TestBridge,
} from './helpers.ts';
import { boardKey, pageKey } from '@once-upon-a-diff/state/records/page-links/page-key';
import { createLocalStory } from '@once-upon-a-diff/stories/local-story';
import { clearCache } from '@once-upon-a-diff/core/features/review/drafts';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { readFixes } from '@once-upon-a-diff/state/queues/requests/fixes';
import {
  strictAgentEvent,
  strictBacklogEvent,
  strictBuild,
  strictFixRequest,
  strictInboxEntry,
} from '@once-upon-a-diff/contracts/files/strict';

// Write checks (card bl_mw4p3n9h7dadb2): a repo typed by hand warns and is written (refused only at ADR-25's flip), a line no
// reader would take is refused, and no flow the live files show is refused. The row shapes below are the ones the census of
// ~/.once-upon found on 11/6 (notes/research/2026-11-06-ou-write-checks-plan.md).
const SID = 'eeea873a';
const env = { CLAUDE_CODE_SESSION_ID: `${SID}-0000-4000-8000-000000000000` };
const WIDGETS = 'acme/widgets';

/** A home that works in acme/widgets (a checkout seen), and a folder that is no checkout, so no repo is taken from an origin. */
function world() {
  const home = tmp('write-checks-home');
  writeJson(path.join(home, 'checkouts.json'), { [WIDGETS]: tmp('write-checks-checkout') });
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('write-checks-sessions') });
  const cwd = tmp('write-checks-cwd');
  const cli = (...args: string[]) => runCli(home, args, env, cwd);
  const rows = (file: string) =>
    readFileSync(path.join(home, file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { home, cwd, cli, rows };
}
/** A command that must have worked. */
const fail = (what: string, result: { code?: unknown; stderr: string }) =>
  assert.equal(result.code, 0, `${what}: ${result.stderr}`);
const NONE = /is on none of the repos this machine works in/;

test('agent start --repo with a typo warns, names the nearest repo, exits 0 and writes the row', async () => {
  const { cli, rows } = world();
  const typo = await cli(
    'agent',
    'start',
    'review-x',
    '--kind',
    'helper',
    '--task',
    't',
    '--repo',
    'esshank/widgets',
  );
  assert.equal(typo.code, 0, typo.stderr);
  assert.match(typo.stderr, /repo esshank\/widgets is on none/);
  assert.match(typo.stderr, /did you mean acme\/widgets\?/);
  assert.equal(rows('agents.jsonl')[0].repo, 'esshank/widgets', 'written as typed');
  // a known repo, in any case, and no --repo at all (the checkout's, which is none here) say nothing
  for (const args of [['--repo', 'Acme/Widgets'], ['--repo', WIDGETS], []]) {
    const quiet = await cli('agent', 'start', 'quiet', '--kind', 'helper', '--task', 't', ...args);
    assert.equal(quiet.code, 0, quiet.stderr);
    assert.equal(quiet.stderr, '', args.join(' '));
  }
});

test('agent start on a card: a typed repo is checked only when the card has none; one the card has is "ignored" once', async () => {
  const { home, cli } = world();
  const store = new BacklogStore(home);
  const bare = store.add({ title: 'No repo yet' });
  const withRepo = store.add({ title: 'On widgets', repo: WIDGETS });
  const first = await cli(
    'agent',
    'start',
    'one',
    '--kind',
    'author',
    '--card',
    bare.id,
    '--task',
    't',
    '--repo',
    'esshank/widgets',
  );
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stderr, NONE);
  const second = await cli(
    'agent',
    'start',
    'two',
    '--kind',
    'author',
    '--card',
    withRepo.id,
    '--task',
    't',
    '--repo',
    'esshank/widgets',
  );
  assert.equal(second.code, 0, second.stderr);
  assert.equal(
    second.stderr.match(/--repo esshank\/widgets ignored/g)?.length,
    1,
    'the registry says it once',
  );
  assert.doesNotMatch(second.stderr, NONE, 'and the typed-repo note does not say it twice');
});

test('backlog add, start, edit and claim with a typed repo on no known lane warn and write; known, empty or no --repo say nothing', async () => {
  const { home, cli, rows } = world();
  const added = await cli('backlog', 'add', 'A card', '--repo', 'eshank/widgets');
  assert.equal(added.code, 0, added.stderr);
  assert.match(added.stderr, /repo eshank\/widgets is on none.*did you mean acme\/widgets/);
  const id = /^(bl_[a-z0-9]+) added/.exec(added.stdout)?.[1] as string;
  assert.equal(rows('backlog.jsonl')[0].repo, 'eshank/widgets');
  for (const args of [['--repo', 'ACME/widgets'], []]) {
    const quiet = await cli('backlog', 'add', 'Another', ...args);
    assert.equal(quiet.code, 0, quiet.stderr);
    assert.equal(quiet.stderr, '', args.join(' '));
  }
  const edit = await cli('backlog', 'edit', id, '--repo', 'esshank/widgets');
  assert.equal(edit.code, 0, edit.stderr);
  assert.match(edit.stderr, NONE);
  assert.equal(
    new BacklogStore(home).items().find((one) => one.id === id)?.repo,
    'esshank/widgets',
  );
  for (const repo of [WIDGETS, '']) {
    const quiet = await cli('backlog', 'edit', id, '--repo', repo);
    assert.equal(quiet.code, 0, quiet.stderr);
    assert.equal(quiet.stderr, '', `edit --repo "${repo}"`);
  }
  // a card with no repo takes the typed one on start and on claim --branch; a card with one is not asked
  const bare = new BacklogStore(home).add({ title: 'Bare' });
  const started = await cli(
    'backlog',
    'start',
    bare.id,
    '--branch',
    'feat/x',
    '--repo',
    'esshank/widgets',
  );
  assert.equal(started.code, 0, started.stderr);
  assert.match(started.stderr, NONE);
  const other = new BacklogStore(home).add({ title: 'Other' });
  const claimed = await cli(
    'backlog',
    'claim',
    other.id,
    '--agent',
    'ou-x',
    '--branch',
    'feat/y',
    '--repo',
    'esshank/widgets',
  );
  assert.equal(claimed.code, 0, claimed.stderr);
  assert.match(claimed.stderr, NONE);
  const onRepo = new BacklogStore(home).add({ title: 'On widgets', repo: WIDGETS });
  const same = await cli('backlog', 'claim', onRepo.id, '--agent', 'ou-y', '--repo', WIDGETS);
  assert.equal(same.stderr, '');
});

test('editor start --repo with a typo warns and registers', async () => {
  const { cli } = world();
  const result = await cli(
    'editor',
    'start',
    'editor-x',
    '--slots',
    '2',
    '--repo',
    'esshank/widgets',
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, NONE);
});

test('agent finish naming another card than its start warns and writes; a start with no card, or the same card, says nothing', async () => {
  const { home, cli, rows } = world();
  const store = new BacklogStore(home);
  const one = store.add({ title: 'One', repo: WIDGETS });
  const two = store.add({ title: 'Two', repo: WIDGETS });
  await cli('agent', 'start', 'ou-a', '--kind', 'author', '--card', one.id, '--task', 't');
  const mismatch = await cli('agent', 'finish', 'ou-a', '--card', two.id, '--outcome', 'ok');
  assert.equal(mismatch.code, 0, mismatch.stderr);
  assert.match(
    mismatch.stderr,
    new RegExp(`--card ${two.id} is not the card ou-a started on \\(${one.id}\\)`),
  );
  assert.equal(rows('agents.jsonl').at(-1).result.card, two.id, 'written as given');

  await cli('agent', 'start', 'ou-b', '--kind', 'author', '--card', one.id, '--task', 't');
  const same = await cli('agent', 'finish', 'ou-b', '--card', one.id);
  assert.equal(same.stderr, '');
  // the 11/5 shape: no card at start, the card named on finish (the global rule), 17 of the live finishes
  await cli('agent', 'start', 'ou-c', '--kind', 'author', '--task', 't');
  const later = await cli('agent', 'finish', 'ou-c', '--card', two.id, '--branch', 'feat/c');
  assert.equal(later.code, 0, later.stderr);
  assert.equal(later.stderr, '');
  // a card that is not one is said, and still written
  await cli('agent', 'start', 'ou-d', '--kind', 'author', '--task', 't');
  const unknown = await cli('agent', 'finish', 'ou-d', '--card', 'bl_nothere123');
  assert.equal(unknown.code, 0, unknown.stderr);
  assert.match(unknown.stderr, /is not a backlog card/);
});

test('a local story with no GitHub remote can still be rebuilt: its build request is written, not refused', () => {
  const home = tmp('write-checks-local-rebuild');
  const builds = new Builds(home);
  for (const [story, repo] of [
    ['local-a', null],
    ['local-b', 'my-folder'],
    ['local-c', 'shank-eric/once-upon-a-diff'],
  ] as const) {
    const meta = {
      kind: 'local',
      repo,
      repo_path: '/x',
      base: 'main',
      head: 'feat',
      head_oid: 'abc',
    };
    const made = builds.requestRebuild({ story, meta, mode: 'rebuild', chapters: 1 } as never);
    assert.equal(made.status, 'pending');
  }
  assert.deepEqual(Object.keys(builds.all()), ['story:local-a', 'story:local-b', 'story:local-c']);
});

const open: TestBridge[] = [];
after(async () => {
  for (const bridge of open) {
    await bridge.close();
  }
});

test('the board Edit form: a repo typed on no known lane is saved and comes back as a warning; a known one is not warned', async () => {
  const { home } = world();
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Edit me' });
  const bridge = await startBridge({ home });
  open.push(bridge);
  const withKey = { Authorization: `Bearer ${boardKey(TOKEN)}` };
  const typo = await bridge.call<{ ok: boolean; warnings?: string[] }>(
    'POST',
    '/api/board/backlog/edit',
    { id: item.id, repo: 'esshank/widgets' },
    withKey,
  );
  assert.equal(typo.status, 200);
  assert.equal(typo.body.warnings?.length, 1);
  assert.match(typo.body.warnings?.[0] ?? '', /did you mean acme\/widgets/);
  assert.equal(store.items()[0].repo, 'esshank/widgets', 'saved all the same');
  const known = await bridge.call<{ ok: boolean; warnings?: string[] }>(
    'POST',
    '/api/board/backlog/edit',
    { id: item.id, repo: WIDGETS },
    withKey,
  );
  assert.equal(known.status, 200);
  assert.equal(known.body.warnings, undefined);
  const title = await bridge.call<{ warnings?: string[] }>(
    'POST',
    '/api/board/backlog/edit',
    { id: item.id, title: 'New title' },
    withKey,
  );
  assert.equal(title.body.warnings, undefined);
});

test('no live flow is refused: the agent and backlog row shapes of the 11/6 census go through the CLI, and each line passes the strict check', async () => {
  const { home, cli, rows } = world();
  const store = new BacklogStore(home);

  // a card, as the editor makes and claims it (no --sid on a claim: 52 of 279 live claims; --sid on the editor's)
  const added = await cli(
    'backlog',
    'add',
    'id module B',
    '--note',
    'plan',
    '--repo',
    WIDGETS,
    '--by',
    'eric',
  );
  fail('add', added);
  const id = /^(bl_[a-z0-9]+) added/.exec(added.stdout)?.[1] as string;
  fail(
    'claim without a sid',
    await cli('backlog', 'claim', id, '--agent', 'write-checks', '--branch', 'write-checks'),
  );
  fail(
    'claim with a sid',
    await cli('backlog', 'claim', id, '--agent', 'write-checks', '--sid', SID),
  );
  fail('hold', await cli('backlog', 'hold', id));
  fail('hold off', await cli('backlog', 'hold', id, '--off'));
  const other = store.add({ title: 'second', repo: WIDGETS });
  fail('move', await cli('backlog', 'move', other.id, '--before', id));
  fail('edit', await cli('backlog', 'edit', other.id, '--title', 'second, renamed', '--note', ''));
  fail('someday', await cli('backlog', 'someday', other.id));
  fail('someday off', await cli('backlog', 'someday', other.id, '--off'));
  fail('drop', await cli('backlog', 'drop', other.id));
  fail('reopen', await cli('backlog', 'reopen', other.id));

  // an author: the alias kind old skills still pass, restarts as a fix round, plan stop, a beat, finish with the 11/5 flags
  fail(
    'start builder',
    await cli(
      'agent',
      'start',
      'write-checks',
      '--kind',
      'builder',
      '--card',
      id,
      '--task',
      'card B',
      '--model',
      'sonnet',
      '--effort',
      'high',
      '--sid',
      SID,
    ),
  );
  fail(
    'state plan',
    await cli(
      'agent',
      'state',
      'write-checks',
      '--state',
      'plan',
      '--outcome',
      'plan ready: /x/y.md',
    ),
  );
  fail(
    'beat',
    await cli(
      'agent',
      'beat',
      'write-checks',
      '2/6',
      'plan',
      '--no-mirror',
      '--',
      'a note starting --dashed',
    ),
  );
  fail('state running', await cli('agent', 'state', 'write-checks', '--state', 'running'));
  fail(
    'finish',
    await cli(
      'agent',
      'finish',
      'write-checks',
      '--state',
      'done',
      '--commit',
      '0123456789abcdef0123456789abcdef01234567',
      '--branch',
      'write-checks',
      '--card',
      id,
      '--outcome',
      'done',
    ),
  );
  fail(
    'restart (a fix round)',
    await cli('agent', 'start', 'write-checks', '--card', id, '--task', 'fix round', '--sid', SID),
  );
  fail(
    'fixing',
    await cli('agent', 'state', 'write-checks', '--state', 'fixing', '--findings', '2'),
  );
  fail('finish stopped', await cli('agent', 'finish', 'write-checks', '--state', 'stopped'));
  // a critic (with its findings), helpers, a researcher and an editor, none with a card or a typed repo
  fail(
    'critic',
    await cli(
      'agent',
      'start',
      'review-x',
      '--role',
      'critic',
      '--card',
      id,
      '--task',
      'review',
      '--sid',
      SID,
    ),
  );
  fail(
    'critic finish',
    await cli('agent', 'finish', 'review-x', '--state', 'done', '--findings', '0'),
  );
  fail(
    'helper',
    await cli(
      'agent',
      'start',
      'backlog-clerk',
      '--kind',
      'helper',
      '--standing',
      '--task',
      'clerk',
    ),
  );
  fail(
    'reviewer alias',
    await cli(
      'agent',
      'start',
      'old-reviewer',
      '--kind',
      'reviewer',
      '--task',
      'old skill line',
      '--card',
      id,
    ),
  );
  fail('research', await cli('agent', 'start', 'look', '--kind', 'research', '--task', 'look'));
  fail('editor', await cli('editor', 'start', 'editor-eeea873a', '--slots', '3'));
  fail('sweep', await cli('agent', 'sweep'));
  // the deploy: backlog land marks a card done by the commit its agent recorded
  store.done(id, { sha: '0123456789abcdef0123456789abcdef01234567', by: 'deploy-local' });

  for (const line of rows('agents.jsonl')) {
    assert.deepEqual(strictAgentEvent(line), [], JSON.stringify(line));
  }
  assert.equal(rows('agents.jsonl').find((one) => one.name === 'old-reviewer')?.kind, 'critic');
  for (const line of rows('backlog.jsonl')) {
    assert.deepEqual(strictBacklogEvent(line), [], JSON.stringify(line));
  }

  assert.ok(new AgentRegistry(home).agents().length >= 6);
});

test('no live flow is refused: the inbox, fixes and builds lines come from the real routes and commands, and each passes the strict check', async () => {
  clearCache();
  const fakeGh = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-gh.ts');
  chmodSync(fakeGh, 0o755);
  const saved = { gh: process.env.ONCE_UPON_GH, graphql: process.env.FAKE_GH_GRAPHQL };
  process.env.ONCE_UPON_GH = fakeGh;
  process.env.FAKE_GH_GRAPHQL = '1';
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args.join(' '));
  const { home, cli, rows } = world();
  const story = 'acme-widgets-7';
  const base = `/api/stories/${story}`;
  githubStory(path.join(home, story), { meta: { head_ref: 'feature/widgets' } });
  writeJson(path.join(home, story, 'chapters.json'), {
    title: 'Widgets',
    chapters: [
      {
        title: 'Chapter 1: Start',
        files: ['src/a.js', 'README.md'],
        comments: [
          { path: 'README.md', line: 4, body: 'Typo: "teh".' },
          { path: 'src/a.js', line: 2, body: 'Could this be shorter?' },
        ],
      },
    ],
  });
  // a local story on a real checkout, for Approve
  const { repo, base: from } = localRepo();
  git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  const chapters = path.join(tmp('write-checks-ch'), 'chapters.json');
  writeJson(chapters, {
    title: 'Two commits',
    chapters: [{ refs: [], title: 'Chapter 1', narrative: 'Told.', files: ['one.txt'] }],
  });
  const local = createLocalStory({ home, repo, base: from, head: 'HEAD', chapters });
  const bridge = await startBridge({ home });
  open.push(bridge);
  try {
    const post = async (url: string, body: unknown, headers?: Record<string, string>) => {
      const response = await bridge.call<{ id?: string; sent?: { id: string } }>(
        'POST',
        url,
        body,
        headers,
      );
      assert.equal(response.status, 200, `${url}: ${response.text}`);
      return response.body;
    };
    // the panel
    await post(`${base}/read`, { chapter: 'start', step: 1, reason: 'time', seconds: 95 });
    const question = await post(`${base}/questions`, {
      text: 'Why?',
      step: 1,
      chapter: 'Chapter 1: Start',
    });
    fail('answer', await cli('answer', '--question', question.id as string, '--text', 'Because.'));
    fail('ask --voice', await cli('ask', '--story', story, '--text', 'Aloud?', '--voice'));
    await post(`${base}/drafts`, { chapter: 1, index: 0, action: 'review' });
    await post(`${base}/notes`, { path: 'src/a.js', line: 3, body: 'One' });
    await post(`${base}/drafts`, { chapter: 1, index: 1, action: 'fix' });
    const sent = await post(`${base}/fixes`, { action: 'send' });
    fail(
      'fixed',
      await cli(
        'fixed',
        '--request',
        sent.sent?.id as string,
        '--sha',
        'abc1234',
        '--consumer',
        'api-10',
      ),
    );
    fail(
      'comment',
      await cli(
        'comment',
        '--story',
        story,
        '--chapter',
        '1',
        '--path',
        'src/a.js',
        '--line',
        '4',
        '--body',
        'Check this.',
      ),
    );
    await post(
      `/api/stories/${local.id}/approve`,
      { head_sha: git(repo, 'rev-parse', 'HEAD') },
      { Authorization: `Bearer ${pageKey(TOKEN, local.id)}` },
    );
    // the extension's build request, with a time in the old form
    await post('/api/builds', {
      repo: 'EverFi/everfi-frontend',
      number: 6943,
      requested_at: '2026-10-20T21:40:00Z',
    });
  } finally {
    console.error = original;
    for (const [name, value] of [
      ['ONCE_UPON_GH', saved.gh],
      ['FAKE_GH_GRAPHQL', saved.graphql],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
  const lines = rows('inbox.jsonl');
  assert.deepEqual(
    [...new Set(lines.map((line) => line.type))].sort(),
    ['answer', 'approved', 'comment', 'fix', 'note', 'question', 'read', 'review_comment'],
    'every type the readers take was written by its own writer',
  );
  for (const line of lines) {
    assert.deepEqual(strictInboxEntry(line), [], JSON.stringify(line));
  }
  const fixes = readFixes(home);
  assert.equal(Object.keys(fixes).length, 1);
  for (const [key, record] of Object.entries(fixes)) {
    assert.deepEqual(strictFixRequest(record, key), []);
  }
  const builds = new Builds(home).all();
  assert.deepEqual(Object.keys(builds), ['everfi/everfi-frontend#6943']);
  assert.deepEqual(
    strictBuild(builds['everfi/everfi-frontend#6943'], 'everfi/everfi-frontend#6943'),
    [],
  );
  assert.deepEqual(
    logged.filter((line) => /refused/.test(line)),
    [],
    'nothing was refused',
  );
});
