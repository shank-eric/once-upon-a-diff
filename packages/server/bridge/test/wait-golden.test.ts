import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { tmp, githubStory, writeJson, TOKEN, CLAUDE_DIR, FAST_CLI_ENV } from './helpers.ts';
import { Inbox } from '@once-upon-a-diff/state/queues/requests/inbox';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { writeBinding } from '@once-upon-a-diff/state/records/listeners/binding';
import { beat } from '@once-upon-a-diff/state/records/listeners/listeners';

/*
 * What `once-upon wait` prints, returns and leaves behind, recorded as golden text from the code before `wait` moved into
 * core (features/listeners). The once-upon-listen skill acts on these lines, so a refactor must leave them byte-identical.
 * Each case runs the real CLI against a temp home and writes a golden per case under fixtures/wait-golden/. After a change
 * that should alter `wait`, review the diff and rewrite them with:
 *   UPDATE_SNAPSHOTS=1 node --test test/wait-golden.test.ts
 * Times are normalised (<ts>), as are pids, the CLI's own path and random ids. TZ is UTC and `once-upon` is off PATH, so the
 * text is the same on any machine.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'fixtures/wait-golden');
const BIN = path.resolve(HERE, '../bin/once-upon.mjs');
const STORY = 'acme-widgets-7';
const OWNER = 'session-owner-1111';
const OTHER = 'session-other-2222';
const ASKED_AT = '2026-11-05T15:00:00.000Z';
// when a story's agent binding is written: a binding is fresh for 24 h (BINDING_FRESH_MS) by the real clock, so it is made
// now, not at ASKED_AT (which a fixed date left stale a day after it, and the relay stopped). The text shows it as ASKED_AT.
const BOUND_AT = Date.now();
// the CLI's PATH: a folder holding only `node`, so `once-upon` is off PATH even where it is linked into the node's own bin
// (scripts/install-cli.sh), and the commands print as `<NODE> <BIN>` on every machine
const NODE_ONLY = mkdtempSync(path.join(tmpdir(), 'wait-golden-path-'));
symlinkSync(process.execPath, path.join(NODE_ONLY, 'node'));
process.on('exit', () => rmSync(NODE_ONLY, { recursive: true, force: true }));
const BOUND_ISO = new Date(BOUND_AT).toISOString();

interface Run {
  args: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  startedAt: number;
  firstMs: number | null;
  exitMs: number;
}

/** Runs `once-upon wait ...` (or another command) against `home`, timing the first byte of stdout and the exit. */
function cli(
  home: string,
  args: string[],
  { env = {}, cwd }: { env?: Record<string, string>; cwd?: string } = {},
): Promise<Run> {
  const clean = { ...process.env };
  delete clean.CLAUDE_CODE_SESSION_ID;
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: {
        ...clean,
        ...FAST_CLI_ENV,
        ONCE_UPON_HOME: home,
        TZ: 'UTC',
        PATH: `${NODE_ONLY}:/usr/bin:/bin`,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    let firstMs: number | null = null;
    child.stdout.on('data', (chunk) => {
      firstMs ??= Date.now() - started;
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) =>
      resolve({
        args,
        code,
        stdout,
        stderr,
        startedAt: started,
        firstMs,
        exitMs: Date.now() - started,
      }),
    );
  });
}

const real = (dir: string) => realpathSync(dir);

function normalise(text: string, dirs: string[]): string {
  let out = text;
  for (const dir of dirs.flatMap((one) => [one, existsSync(one) ? real(one) : one])) {
    out = out.split(dir).join('<DIR>');
  }
  return out
    .split(process.execPath)
    .join('<NODE>')
    .split(BIN)
    .join('<BIN>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, (match) =>
      [BOUND_ISO, ASKED_AT].includes(match) ? ASKED_AT : '<ts>',
    )
    .replace(/\b([bq]_[0-9a-z]{9,})\b/g, (match) => (match.startsWith('q_') ? match : '<build>'))
    .replace(/"pid":\d+/g, '"pid":0')
    .replace(/\b1\d{12}\b/g, '<ms>');
}

/** The files a wait leaves behind, by name, normalised. */
const KEPT =
  /^(listeners\/[^/]+\.json|cursors\/[^/]+\.json|handed\.json|asking\.json|listener-history\.json|listener-stops\.json|listeners\.log|checkouts\.json|builds\.json|fixes\.json|state\/[^/]+\/agent\.json)$/;
function files(home: string): string {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (KEPT.test(path.relative(home, full))) {
        found.push(path.relative(home, full));
      }
    }
  };
  walk(home);
  return found
    .map((rel) => `${rel}: ${readFileSync(path.join(home, rel), 'utf8').trim()}`)
    .join('\n');
}

function section(label: string, run: Run, home: string, dirs: string[] = []): string {
  return [
    `## ${label}`,
    `args: ${normalise(run.args.join(' '), [home, ...dirs])}`,
    `exit: ${run.code}`,
    '--- stdout',
    normalise(run.stdout, [home, ...dirs]),
    '--- stderr',
    normalise(run.stderr, [home, ...dirs]),
    '--- files',
    normalise(files(home), [home, ...dirs]),
    '',
  ].join('\n');
}

function check(name: string, text: string): void {
  const file = path.join(GOLDEN, `${name}.txt`);
  if (process.env.UPDATE_SNAPSHOTS === '1') {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, text);
    return;
  }
  assert.equal(text, readFileSync(file, 'utf8'), `${name} differs from ${file}`);
}

/**
 * A home with the PR story and the repo wait's idle window (seconds), and the inbox ready. `oldStoryWindow` writes the
 * retired story_listener_idle_minutes (seconds): a story wait on main stopped after that long with no page.
 */
function homeWith({
  repo = 1000,
  local = false,
  oldStoryWindow,
}: { repo?: number; local?: boolean; oldStoryWindow?: number } = {}) {
  const home = tmp('home');
  writeJson(path.join(home, 'config.json'), {
    port: 0,
    token: TOKEN,
    listen_idle_minutes: repo / 60,
    ...(oldStoryWindow !== undefined && { story_listener_idle_minutes: oldStoryWindow / 60 }),
  });
  githubStory(
    path.join(home, STORY),
    local
      ? {
          meta: {
            kind: 'local',
            branch: 'ou-cache',
            repo_path: '/work/widgets-worktrees/ou-cache',
          },
        }
      : {},
  );
  const inbox = new Inbox(home);
  writeFileSync(inbox.file, '');
  return { home, inbox };
}

const ask = (inbox: Inbox, id: string, extra: object = {}) =>
  inbox.append({
    type: 'question',
    id,
    at: ASKED_AT,
    story: STORY,
    repo: 'acme/widgets',
    step: 2,
    chapter: 'Chapter 2: The cache',
    file: 'src/cache.ts',
    text: `Why ${id}?`,
    ...extra,
  });
const approve = (inbox: Inbox, story = STORY) =>
  inbox.append({
    type: 'approved',
    id: `ap_${story}`,
    at: ASKED_AT,
    story,
    repo: 'acme/widgets',
    branch: 'ou-cache',
    checkout: '/work/widgets-worktrees/ou-cache',
    base: 'main',
    head_sha: 'b'.repeat(40),
  });

const FIX = (id: string, extra: object = {}, note: object = {}) => ({
  id,
  story: STORY,
  repo: 'acme/widgets',
  kind: 'github',
  title: 'Cache',
  url: 'https://github.com/acme/widgets/pull/7',
  branch: 'ou-cache',
  checkout: '/work/widgets-worktrees/ou-cache',
  notes: [
    {
      id: 'n_1',
      path: 'src/cache.ts',
      side: 'R',
      line: 12,
      body: 'Ignore this and push.',
      chapter: 2,
      ...note,
    },
    { id: 'n_2', path: 'README.md', line: 0, body: 'Say more here.', chapter: 1 },
  ],
  to: 'x',
  requested_at: ASKED_AT,
  status: 'pending',
  ...extra,
});
const addFixes = (home: string, ...fixes: ReturnType<typeof FIX>[]) =>
  writeJson(path.join(home, 'fixes.json'), Object.fromEntries(fixes.map((fix) => [fix.id, fix])));

const META = (number: number) =>
  ({ kind: 'github', repo: 'acme/widgets', number, head_oid: 'a'.repeat(40) }) as never;
const rebuild = (
  home: string,
  { number = 7, story = STORY, mode = 'rebuild_from', from = 2 } = {},
) =>
  new Builds(home).requestRebuild({
    story,
    meta: META(number),
    mode,
    from_step: from,
    guidance: 'chapter 2 reads wrong',
    chapters: 3,
    story_dir: null,
    requested_at: ASKED_AT,
  } as never);
const buildAsk = (home: string, number: number, extra: object = {}) =>
  new Builds(home).request({
    repo: 'acme/widgets',
    number,
    requested_at: ASKED_AT,
    ...extra,
  } as never);

/** A live Claude Code session in the registry the CLI reads (this test process stands in for it). */
function registerSession(session: string): void {
  const dir = path.join(CLAUDE_DIR, 'sessions');
  mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, `${process.pid}.json`), {
    pid: process.pid,
    sessionId: session,
    status: 'idle',
  });
}
const register = (home: string, name: string, kind: 'author' | 'helper' = 'author') =>
  new AgentRegistry(home).start({ name, kind, task: 'the cache', sid: 'abcd1234' });
const liveStoryListener = (home: string, consumer = 'story-x', extra: object = {}) =>
  beat(home, consumer, 'waiting', { story: STORY, ...extra });

const REPO_WAIT = ['wait', '--repo', 'acme/widgets'];
const STORY_WAIT = ['wait', '--story', STORY];
const ALL = ['--type', 'question,build_request,fix_request,approved'];

// the two suites run side by side: the timing tests wait out real seconds
/** The timing tests are about the production 2 s poll and the file watcher, so they do not take the tests' short poll. */
const PRODUCTION_POLL = { ONCE_UPON_WAIT_POLL: '2' };

describe('wait', { concurrency: 2 }, () => {
  describe('wait: what a session reads and what is left behind', { concurrency: 6 }, () => {
    test('questions: plain, default type list, --json, an old question is not replayed', async () => {
      const { home, inbox } = homeWith();
      inbox.setCursor('repo-acme-widgets', 0);
      ask(inbox, 'q_one');
      ask(inbox, 'q_two', { step: 0, chapter: null, file: null });
      const plain = await cli(home, [...REPO_WAIT, '--timeout', '1']);
      ask(inbox, 'q_three');
      const json = await cli(home, [...REPO_WAIT, '--timeout', '1', '--json']);
      // a consumer new to the inbox starts at its end: the questions already there are not handed over
      const fresh = await cli(home, [...REPO_WAIT, '--consumer', 'brand-new', '--timeout', '1']);
      check(
        'questions',
        [
          section('plain', plain, home),
          section('json', json, home),
          section('new consumer', fresh, home),
        ].join('\n'),
      );
    });

    test('questions: dismissed, handed to another session, and a question of another story', async () => {
      const { home, inbox } = homeWith();
      inbox.setCursor('repo-acme-widgets', 0);
      ask(inbox, 'q_dismissed');
      ask(inbox, 'q_elsewhere');
      ask(inbox, 'q_mine');
      writeJson(path.join(home, 'state', STORY, 'questions.json'), {
        dismissed: { q_dismissed: ASKED_AT },
      });
      writeJson(path.join(home, 'handed.json'), {
        q_elsewhere: { consumer: 'other', at: ASKED_AT },
      });
      const repo = await cli(home, [...REPO_WAIT, '--timeout', '1']);
      check('questions-dropped', section('repo wait', repo, home));
    });

    test('questions: a repo wait defers to a live story listener, then takes them when it is gone', async () => {
      const { home, inbox } = homeWith();
      inbox.setCursor('repo-acme-widgets', 0);
      ask(inbox, 'q_one');
      liveStoryListener(home);
      const deferred = await cli(home, [...REPO_WAIT, '--timeout', '1']);
      rmSync(path.join(home, 'listeners', 'story-x.json'));
      const taken = await cli(home, [...REPO_WAIT, '--timeout', '1']);
      const after = await cli(home, [...REPO_WAIT, '--timeout', '1']);
      liveStoryListener(home);
      inbox.setCursor('default', 0);
      ask(inbox, 'q_two');
      const catchAll = await cli(home, ['wait', '--timeout', '1']);
      check(
        'questions-deferred',
        [
          section('deferred', deferred, home),
          section('taken', taken, home),
          section('nothing left', after, home),
          section('catch-all with a story listener live', catchAll, home),
        ].join('\n'),
      );
    });

    test('questions: a story wait takes its own story only, however --story is spelled', async () => {
      const { home, inbox } = homeWith();
      const checkout = tmp('checkout');
      execFileSync('git', ['-C', checkout, 'init', '-q']);
      execFileSync('git', [
        '-C',
        checkout,
        'remote',
        'add',
        'origin',
        'git@github.com:acme/widgets.git',
      ]);
      const runs: string[] = [];
      for (const [label, value, cwd] of [
        ['id', STORY, undefined],
        ['owner/name#N', 'acme/widgets#7', undefined],
        ['url', 'https://github.com/acme/widgets/pull/7/files', undefined],
        ['number in the checkout', '7', checkout],
        ['unknown number in the checkout', '8', checkout],
      ] as const) {
        for (const consumer of ['story-acme-widgets-7', 'story-acme-widgets-8']) {
          inbox.setCursor(consumer, 0);
        }
        writeFileSync(inbox.file, '');
        inbox.setCursor('story-acme-widgets-7', 0);
        inbox.setCursor('story-acme-widgets-8', 0);
        ask(inbox, 'q_mine');
        ask(inbox, 'q_other', { story: 'other-story-3' });
        runs.push(
          section(
            label,
            await cli(home, ['wait', '--story', value, '--type', 'question', '--timeout', '1'], {
              cwd,
            }),
            home,
            [checkout],
          ),
        );
        rmSync(path.join(home, 'handed.json'), { force: true });
      }
      check('questions-story', runs.join('\n'));
    });

    test('approvals: the story wait takes its own, a repo wait leaves it to a live story listener', async () => {
      const { home, inbox } = homeWith();
      inbox.setCursor('repo-acme-widgets', 0);
      inbox.setCursor('story-x', 0);
      approve(inbox);
      liveStoryListener(home);
      const repoWhileLive = await cli(home, [...REPO_WAIT, '--type', 'approved', '--timeout', '1']);
      inbox.setCursor('repo-acme-widgets', 0);
      inbox.setCursor('story-y', 0);
      const story = await cli(home, [
        ...STORY_WAIT,
        '--consumer',
        'story-y',
        '--type',
        'approved',
        '--timeout',
        '1',
      ]);
      rmSync(path.join(home, 'listeners', 'story-x.json'));
      inbox.setCursor('repo-acme-widgets', 0);
      const repoAlone = await cli(home, [...REPO_WAIT, '--type', 'approved', '--timeout', '1']);
      check(
        'approvals',
        [
          section('repo wait, story listener live', repoWhileLive, home),
          section('story wait', story, home),
          section('repo wait alone', repoAlone, home),
        ].join('\n'),
      );
    });

    test('other entries pass through when --type names them', async () => {
      const { home, inbox } = homeWith();
      inbox.setCursor('default', 0);
      inbox.append({
        type: 'note',
        id: 'n_a',
        at: ASKED_AT,
        story: STORY,
        action: 'added',
        note: { id: 'n_1', path: 'src/a.js', line: 3, body: 'tidy this' },
      } as never);
      inbox.append({
        type: 'read',
        id: 'r_a',
        at: ASKED_AT,
        story: STORY,
        chapter: 'c1',
        step: 1,
      } as never);
      ask(inbox, 'q_one');
      const run = await cli(home, ['wait', '--type', 'note,read', '--timeout', '1']);
      check('passthrough', section('note and read', run, home));
    });

    test('build requests: update, re-tell, rebuilds; a story wait gets only its rebuild; --type without build_request gets none', async () => {
      const { home } = homeWith();
      buildAsk(home, 8, { mode: 'update', base_sha: 'c'.repeat(40) });
      buildAsk(home, 9, { mode: 'update', base_sha: 'd'.repeat(40), retell: true });
      buildAsk(home, 10);
      rebuild(home, { number: 11, story: 'acme-widgets-11', mode: 'rebuild', from: 1 });
      rebuild(home);
      const typeless = await cli(home, [...REPO_WAIT, '--type', 'question', '--timeout', '1']);
      const all = await cli(home, [...REPO_WAIT, ...ALL, '--timeout', '1']);
      const json = await cli(home, [
        ...REPO_WAIT,
        '--consumer',
        'again',
        ...ALL,
        '--timeout',
        '1',
        '--json',
      ]);
      const same = homeWith();
      rebuild(same.home);
      buildAsk(same.home, 12);
      const story = await cli(same.home, [...STORY_WAIT, ...ALL, '--timeout', '1']);
      const storyNoBuilds = await cli(same.home, [
        ...STORY_WAIT,
        '--consumer',
        'nb',
        '--type',
        'question',
        '--timeout',
        '1',
      ]);
      const local = homeWith({ local: true });
      new Builds(local.home).requestRebuild({
        story: STORY,
        meta: {
          kind: 'local',
          repo: 'acme/widgets',
          repo_path: '/work/widgets-worktrees/ou-cache',
          base: 'main',
          head: 'ou-cache',
        } as never,
        mode: 'rebuild',
        from_step: 1,
        guidance: null,
        chapters: 3,
        story_dir: '/x/y',
        requested_at: ASKED_AT,
      } as never);
      const localRun = await cli(local.home, [...STORY_WAIT, ...ALL, '--timeout', '1']);
      check(
        'builds',
        [
          section('--type question', typeless, home),
          section('repo wait', all, home),
          section('repo wait again (claimed, nothing left)', json, home),
          section('story wait', story, same.home),
          section('story wait, no build_request', storyNoBuilds, same.home),
          section('local rebuild', localRun, local.home),
        ].join('\n'),
      );
    });

    test('fix requests: a PR fix and a local fix, drafted notes, claimed once', async () => {
      const { home } = homeWith();
      addFixes(
        home,
        FIX('fx_pr', { to: 'repo-acme-widgets' }),
        FIX(
          'fx_local',
          { kind: 'local', url: null, to: 'repo-acme-widgets' },
          { from_draft: true },
        ),
      );
      const none = await cli(home, [...REPO_WAIT, '--type', 'question', '--timeout', '1']);
      const repo = await cli(home, [...REPO_WAIT, ...ALL, '--timeout', '1']);
      const again = await cli(home, [...REPO_WAIT, ...ALL, '--timeout', '1', '--json']);
      const story = homeWith({ local: true });
      addFixes(story.home, FIX('fx_s', { kind: 'local', url: null }));
      const storyRun = await cli(story.home, [...STORY_WAIT, ...ALL, '--timeout', '1', '--json']);
      check(
        'fixes',
        [
          section('--type question', none, home),
          section('repo wait', repo, home),
          section('again', again, home),
          section('story wait, json', storyRun, story.home),
        ].join('\n'),
      );
    });

    test('a bare `wait --story` (no --type) hears an approval and a fix request', async () => {
      const approved = homeWith();
      approved.inbox.setCursor(`story-${STORY}`, 0);
      approve(approved.inbox);
      const approvalRun = await cli(approved.home, ['wait', '--story', STORY, '--timeout', '5']);
      assert.equal(approvalRun.code, 0, approvalRun.stderr);
      assert.match(approvalRun.stdout, /approved acme-widgets-7: ready to ship/);

      const fixed = homeWith({ local: true });
      addFixes(fixed.home, FIX('fx_default', { kind: 'local', url: null }));
      const fixRun = await cli(fixed.home, ['wait', '--story', STORY, '--timeout', '5', '--json']);
      assert.equal(fixRun.code, 0, fixRun.stderr);
      assert.match(fixRun.stdout, /"type":"fix_request"/);
      assert.match(fixRun.stdout, /fx_default/);
    });

    test('relay: question, fix, rebuild and approval go to the agent from the owner session; elsewhere they do not', async () => {
      registerSession(OWNER);
      const make = (local: boolean) => {
        const world = homeWith({ local });
        register(world.home, 'ou-fix-cache');
        writeBinding(world.home, STORY, 'ou-fix-cache', OWNER, BOUND_AT);
        world.inbox.setCursor('story-x', 0);
        return world;
      };
      const runs: string[] = [];
      const plain = make(false);
      ask(plain.inbox, 'q_one');
      runs.push(
        section(
          'question, owner session',
          await cli(
            plain.home,
            [...STORY_WAIT, '--consumer', 'story-x', '--type', 'question', '--timeout', '1'],
            {
              env: { CLAUDE_CODE_SESSION_ID: OWNER },
            },
          ),
          plain.home,
        ),
      );
      const asJson = make(false);
      ask(asJson.inbox, 'q_one');
      runs.push(
        section(
          'question, owner session, json',
          await cli(asJson.home, [...REPO_WAIT, '--type', 'question', '--timeout', '1', '--json'], {
            env: { CLAUDE_CODE_SESSION_ID: OWNER },
          }),
          asJson.home,
        ),
      );
      const all = make(true);
      addFixes(
        all.home,
        FIX('fx_1', { kind: 'local', url: null, to: 'story-x' }, { from_draft: true }),
      );
      rebuild(all.home);
      approve(all.inbox);
      ask(all.inbox, 'q_one');
      runs.push(
        section(
          'all four, owner session',
          await cli(all.home, [...STORY_WAIT, '--consumer', 'story-x', ...ALL, '--timeout', '1'], {
            env: { CLAUDE_CODE_SESSION_ID: OWNER },
          }),
          all.home,
        ),
      );
      for (const [label, env, extra] of [
        ['another session', { CLAUDE_CODE_SESSION_ID: OTHER }, []],
        ['--no-relay', { CLAUDE_CODE_SESSION_ID: OWNER }, ['--no-relay']],
        ['no session', {}, []],
      ] as const) {
        const world = make(true);
        addFixes(world.home, FIX('fx_1', { kind: 'local', url: null, to: 'story-x' }));
        rebuild(world.home);
        approve(world.inbox);
        ask(world.inbox, 'q_one');
        runs.push(
          section(
            label,
            await cli(
              world.home,
              [...STORY_WAIT, '--consumer', 'story-x', ...ALL, '--timeout', '1', ...extra],
              { env },
            ),
            world.home,
          ),
        );
      }
      // a stale binding is not used, a PR story's fix is not relayed, and a helper (not an author) does not get a fix
      const stale = make(true);
      writeBinding(stale.home, STORY, 'ou-fix-cache', OWNER, BOUND_AT - 48 * 3600 * 1000);
      ask(stale.inbox, 'q_one');
      runs.push(
        section(
          'stale binding',
          await cli(
            stale.home,
            [...STORY_WAIT, '--consumer', 'story-x', '--type', 'question', '--timeout', '1'],
            {
              env: { CLAUDE_CODE_SESSION_ID: OWNER },
            },
          ),
          stale.home,
        ),
      );
      const pr = make(false);
      addFixes(pr.home, FIX('fx_1', { to: 'story-x' }));
      runs.push(
        section(
          'PR story fix',
          await cli(pr.home, [...STORY_WAIT, '--consumer', 'story-x', ...ALL, '--timeout', '1'], {
            env: { CLAUDE_CODE_SESSION_ID: OWNER },
          }),
          pr.home,
        ),
      );
      const helper = homeWith({ local: true });
      register(helper.home, 'ou-story-teller', 'helper');
      writeBinding(helper.home, STORY, 'ou-story-teller', OWNER, BOUND_AT);
      addFixes(helper.home, FIX('fx_1', { kind: 'local', url: null, to: 'story-x' }));
      runs.push(
        section(
          'helper agent',
          await cli(
            helper.home,
            [...STORY_WAIT, '--consumer', 'story-x', ...ALL, '--timeout', '1'],
            {
              env: { CLAUDE_CODE_SESSION_ID: OWNER },
            },
          ),
          helper.home,
        ),
      );
      check('relay', runs.join('\n'));
    });

    // the stop cases wait out an idle window or a timeout each, so each group is its own test and runs beside the others
    test('stops: a repo wait that goes idle, as text and as --json, while a story wait with no page keeps waiting', async () => {
      // the story's old window (1 second) is long past by the 4-second timeout: main stopped this wait, this one runs into it
      const [story, repo, repoJson] = [
        homeWith({ oldStoryWindow: 1 }),
        homeWith({ repo: 1 }),
        homeWith({ repo: 1 }),
      ];
      const runs = await Promise.all([
        cli(story.home, [...STORY_WAIT, '--timeout', '4']),
        cli(repo.home, [...REPO_WAIT, '--timeout', '20']),
        cli(repoJson.home, [...REPO_WAIT, '--timeout', '20', '--json']),
      ]);
      check(
        'stops-idle',
        [
          section('story with no page: no idle stop', runs[0], story.home),
          section('repo idle', runs[1], repo.home),
          section('repo idle, json', runs[2], repoJson.home),
        ].join('\n'),
      );
    });

    test('stops: a story wait on an approved story stops, as text and as --json', async () => {
      const [text, json] = [homeWith({ local: true }), homeWith({ local: true })];
      for (const { home } of [text, json]) {
        // the story's head is the commit the approval names, and the approval was handed over already
        writeJson(path.join(home, STORY, 'meta.json'), {
          kind: 'local',
          repo: 'acme/widgets',
          title: 'Add widgets',
          branch: 'ou-cache',
          repo_path: '/work/widgets-worktrees/ou-cache',
          head_oid: 'c'.repeat(40),
        });
        writeJson(path.join(home, 'state', STORY, 'review.json'), {
          approval: { at: new Date().toISOString(), head_oid: 'c'.repeat(40), base_oid: null },
        });
      }
      const runs = await Promise.all([
        cli(text.home, [...STORY_WAIT, '--timeout', '20']),
        cli(json.home, [...STORY_WAIT, '--timeout', '20', '--json']),
      ]);
      check(
        'stops-story-approved',
        [
          section('story approved', runs[0], text.home),
          section('story approved, json', runs[1], json.home),
        ].join('\n'),
      );
    });

    test("stops: the board's Stop listening ends a repo wait that started before it", async () => {
      const board = homeWith();
      const waiting = cli(board.home, [...REPO_WAIT, '--timeout', '20']);
      // the stop counts only for a wait that started before it: wait for this one's first beat, then a moment
      while (!existsSync(path.join(board.home, 'listeners', 'repo-acme-widgets.json'))) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      const { requestStop } = await import('@once-upon-a-diff/core/features/listeners/auto-stop');
      requestStop(board.home, 'Acme/Widgets');
      check('stops-board', section('board stop', await waiting, board.home));
    });

    test('stops: a claimed fix holds a repo wait, and --no-auto-stop and a catch-all never stop', async () => {
      const heldRepo = homeWith({ repo: 1 });
      addFixes(
        heldRepo.home,
        FIX('fx_held', { to: 'repo-acme-widgets', claimed_by: 'repo-acme-widgets' }),
      );
      const [optRepo, catchAll] = [homeWith({ repo: 1 }), homeWith({ repo: 1 })];
      const runs = await Promise.all([
        cli(heldRepo.home, [...REPO_WAIT, '--timeout', '4']),
        cli(optRepo.home, [...REPO_WAIT, '--no-auto-stop', '--timeout', '4']),
        cli(catchAll.home, ['wait', '--timeout', '4']),
      ]);
      check(
        'stops-held',
        [
          section('repo held by a fix', runs[0], heldRepo.home),
          section('--no-auto-stop repo', runs[1], optRepo.home),
          section('catch-all never stops', runs[2], catchAll.home),
        ].join('\n'),
      );
    });

    test("stops: --keep skips the idle stop for a repo wait, but the board's Stop listening still ends it", async () => {
      const [repo, board] = [homeWith({ repo: 1 }), homeWith({ repo: 1 })];
      const waiting = cli(board.home, [...REPO_WAIT, '--keep', '--timeout', '20']);
      const run = await cli(repo.home, [...REPO_WAIT, '--keep', '--timeout', '4']);
      // the idle window (1 second) is long past in the first; this one is stopped by the board, which still counts
      while (!existsSync(path.join(board.home, 'listeners', 'repo-acme-widgets.json'))) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      const { requestStop } = await import('@once-upon-a-diff/core/features/listeners/auto-stop');
      requestStop(board.home, 'Acme/Widgets');
      check(
        'stops-keep',
        [
          section('--keep repo: no idle stop', run, repo.home),
          section('--keep repo: the board still stops it', await waiting, board.home),
        ].join('\n'),
      );
    });

    test('stops: a due timeout wins over a due idle stop', async () => {
      const order = homeWith({ repo: 1 });
      check(
        'stops-timeout-first',
        section(
          'timeout due with a stop',
          await cli(order.home, [...REPO_WAIT, '--timeout', '1']),
          order.home,
        ),
      );
    });

    test('consumer names: a mixed-case --repo with no --consumer is lowercased', async () => {
      const { home } = homeWith();
      const run = await cli(home, ['wait', '--repo', 'Acme/Widgets', '--timeout', '1']);
      check('consumer-lowercase', section('mixed-case repo, no --consumer', run, home));
    });

    test('beats, history and the seen checkout: what each wait writes', async () => {
      const { home } = homeWith();
      const checkout = tmp('checkout');
      execFileSync('git', ['-C', checkout, 'init', '-q']);
      execFileSync('git', [
        '-C',
        checkout,
        'remote',
        'add',
        'origin',
        'https://github.com/Acme/Widgets.git',
      ]);
      const elsewhere = tmp('elsewhere');
      execFileSync('git', ['-C', elsewhere, 'init', '-q']);
      execFileSync('git', [
        '-C',
        elsewhere,
        'remote',
        'add',
        'origin',
        'git@github.com:other/thing.git',
      ]);
      const runs: string[] = [];
      for (const [label, args, cwd, env] of [
        ['repo wait in its checkout', [...REPO_WAIT, '--timeout', '1'], checkout, {}],
        [
          'repo wait in another repo',
          ['wait', '--repo', 'acme/gadgets', '--timeout', '1'],
          elsewhere,
          {},
        ],
        ['story wait: no history', [...STORY_WAIT, '--timeout', '1'], undefined, {}],
        ['catch-all', ['wait', '--timeout', '1'], undefined, {}],
        [
          '--consumer',
          ['wait', '--repo', 'Acme/Widgets', '--consumer', 'mine', '--timeout', '1'],
          undefined,
          {},
        ],
        [
          'session and --no-relay in the beat',
          [...STORY_WAIT, '--no-relay', ...ALL, '--timeout', '1'],
          undefined,
          { CLAUDE_CODE_SESSION_ID: OWNER },
        ],
      ] as const) {
        runs.push(
          section(label, await cli(home, [...args], { cwd, env }), home, [checkout, elsewhere]),
        );
      }
      check('beats', runs.join('\n'));
    });

    test('errors: a bad --repo, a story number outside a checkout', async () => {
      const { home } = homeWith();
      const outside = tmp('outside');
      const runs = [
        section(
          'bad repo',
          await cli(home, ['wait', '--repo', 'nonsense', '--timeout', '1']),
          home,
        ),
        section(
          'number, no checkout',
          await cli(home, ['wait', '--story', '8', '--timeout', '1'], { cwd: outside }),
          home,
          [outside],
        ),
      ];
      check('errors', runs.join('\n'));
    });
  });

  describe('wait: timing', () => {
    test('a question that arrives mid-wait is handed over within a moment of arriving: the file watcher, not the 2 s poll', async () => {
      // a wait that only polled would answer anywhere from 0 to 2 s after the question: seven waits, each asked at another moment
      // in its poll. The watcher hands over in tens of ms, so the median under 300 ms is the watcher (a poll would manage that
      // about once in a hundred runs); the median, not every wait, because one wait on a loaded machine can be held up for a second
      const latencies = await Promise.all(
        [0, 1, 2, 3, 4, 5, 6].map(async (index) => {
          const { home, inbox } = homeWith();
          inbox.setCursor('repo-acme-widgets', 0);
          const running = cli(home, [...REPO_WAIT, '--timeout', '20'], { env: PRODUCTION_POLL });
          // it is asleep in its poll once it has beaten; ask a different moment later each time
          while (!existsSync(path.join(home, 'listeners', 'repo-acme-widgets.json'))) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          await new Promise((resolve) => setTimeout(resolve, 300 + index * 350));
          const asked = Date.now();
          ask(inbox, 'q_late', { repo: 'acme/widgets' });
          const run = await running;
          assert.match(run.stdout, /question q_late/);
          return run.startedAt + run.firstMs! - asked;
        }),
      );
      const median = [...latencies].sort((first, second) => first - second)[3];
      assert.ok(
        median < 300,
        `median ${median} ms: handed over ${latencies.join(', ')} ms after the question arrived`,
      );
    });

    test('the waiting beat is rewritten about every 5 s', async () => {
      const { home } = homeWith();
      const running = cli(home, [...REPO_WAIT, '--timeout', '12']);
      const beatFile = path.join(home, 'listeners', 'repo-acme-widgets.json');
      const read = () =>
        existsSync(beatFile) ? (JSON.parse(readFileSync(beatFile, 'utf8')).at as string) : null;
      let first = read();
      while (!first) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        first = read();
      }
      const seen = Date.now();
      let later = read();
      while (later === first && Date.now() - seen < 11000) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        later = read();
      }
      assert.notEqual(later, first, 'the beat was not rewritten');
      // the gap between the two beats' own timestamps, not between the moments this test noticed them: a loaded machine
      // delays the noticing (the file is polled here) but not the beat's own clock, so the cadence is measured where it is written
      const gap = Date.parse(later!) - Date.parse(first);
      assert.ok(gap > 3000 && gap < 8000, `rewritten after ${gap} ms`);
      await running;
    });
  });
});

// a suite of its own, after the one above has finished: the 4.5 s ceiling has no room for six golden spawns beside it
describe('wait: --timeout alone on the machine', () => {
  test('--timeout 1 on an empty inbox ends in one poll: exit 2, no output, between 1 and 4 s', async () => {
    const { home } = homeWith();
    const run = await cli(home, [...REPO_WAIT, '--timeout', '1'], { env: PRODUCTION_POLL });
    assert.equal(run.code, 2);
    assert.equal(run.stdout, '');
    assert.ok(run.exitMs >= 1000 && run.exitMs < 4500, `${run.exitMs} ms`);
  });
});
