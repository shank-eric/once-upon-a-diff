/** extras/hooks/listen-pending.sh: claims a queued Start listening for the first session you use in that repo's checkout. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson, git } from './helpers.ts';
import { worktreeFixture } from '@once-upon-a-diff/test-kit/git';
import { ROOT, runScript } from './script-helpers.ts';

const has = (cmd: string) => {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const HOOK = path.join(ROOT, 'extras/hooks/listen-pending.sh');
const SKIP = { skip: !has('jq') };
const FAR = Date.now() + 15 * 60 * 1000;

/** A home with a pending request (`entry` over a repo target for acme/widgets) */
function pending(entry: Record<string, unknown> = {}, key = 'repo-acme-widgets') {
  const home = tmp('listen-hook');
  const dir = path.join(home, 'pending-listen');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${key}.json`);
  writeJson(file, {
    v: 1,
    key,
    repo: 'acme/widgets',
    story: null,
    checkout: null,
    at: Date.now(),
    expires: FAR,
    ...entry,
  });
  return { home, dir, file };
}

const run = (
  home: string,
  input: Record<string, unknown>,
  extra: Record<string, string | null> = {},
) => runScript(HOOK, [], { ONCE_UPON_HOME: home, ...extra }, JSON.stringify(input));

const submit = (cwd: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: 'UserPromptSubmit',
  session_id: 'sess-1',
  cwd,
  prompt: 'go ahead',
  ...extra,
});

test(
  'listen-pending.sh: the first typed message in the repo claims the request, prints the sentence and removes the file',
  SKIP,
  async () => {
    const { main } = worktreeFixture();
    const { home, dir, file } = pending();
    const first = await run(home, submit(main));
    assert.equal(first.code, 0);
    const out = JSON.parse(first.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.equal(
      out.hookSpecificOutput.additionalContext,
      'The user pressed Start listening in Once Upon a Diff. Before answering their message, run the /once-upon-listen skill with arguments `acme/widgets --keep`.',
    );
    assert.equal(existsSync(file), false);
    assert.deepEqual(
      readdirSync(path.join(dir, 'claimed')),
      [],
      'the claimed file is removed at once',
    );
    // another session finds nothing
    const second = await run(home, submit(main, { session_id: 'sess-2' }));
    assert.equal(second.code, 0);
    assert.equal(second.stdout, '');
  },
);

const start = (cwd: string, source: string | null) => ({
  hook_event_name: 'SessionStart',
  session_id: 's-9',
  cwd,
  ...(source ? { source } : {}),
});

test(
  'listen-pending.sh: a fresh session (startup) claims too, and says its own event',
  SKIP,
  async () => {
    const { main } = worktreeFixture();
    const { home } = pending();
    const out = JSON.parse((await run(home, start(main, 'startup'))).stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(out.hookSpecificOutput.additionalContext, /acme\/widgets --keep/);
  },
);

test(
  'listen-pending.sh: a SessionStart that is not a fresh start (compact, resume, clear, none) leaves the request alone',
  SKIP,
  async () => {
    const { main } = worktreeFixture();
    const { home, file } = pending();
    for (const source of ['compact', 'resume', 'clear', 'something-new', null]) {
      const out = await run(home, start(main, source));
      assert.equal(out.code, 0, String(source));
      assert.equal(out.stdout, '', String(source));
      assert.equal(existsSync(file), true, String(source));
    }
  },
);

test(
  'listen-pending.sh: the repo matches without case, and from a folder inside the checkout',
  SKIP,
  async () => {
    const { main } = worktreeFixture('widgets', 'https://github.com/Acme/Widgets.git');
    mkdirSync(path.join(main, 'sub'));
    const { home } = pending();
    const run1 = await run(home, submit(path.join(main, 'sub')));
    assert.match(run1.stdout, /acme\/widgets --keep/);
  },
);

test(
  'listen-pending.sh: nothing printed and the request left for another repo, an expired request, no home, a hostile repo, a bad session id, a relative cwd',
  SKIP,
  async () => {
    const { main } = worktreeFixture('gadgets', 'git@github.com:acme/gadgets.git');
    const wrong = pending();
    assert.equal((await run(wrong.home, submit(main))).stdout, '');
    assert.equal(existsSync(wrong.file), true, 'another repo leaves it for its own session');

    const widgets = worktreeFixture().main;
    const old = pending({ expires: Date.now() - 1000 });
    assert.equal((await run(old.home, submit(widgets))).stdout, '');
    assert.equal(
      existsSync(old.file),
      false,
      'a lapsed request is removed, not skipped on every prompt',
    );

    const missing = path.join(tmp('listen-none'), 'nope');
    const none = await run(missing, submit(widgets));
    assert.equal(none.code, 0);
    assert.equal(none.stdout, '');

    const hostile = pending({ repo: 'x; rm -rf ~' });
    assert.equal((await run(hostile.home, submit(widgets))).stdout, '');
    assert.equal(existsSync(hostile.file), true);

    const hostileStory = pending({ repo: null, story: 'a b; rm', checkout: widgets }, 'story-x');
    assert.equal((await run(hostileStory.home, submit(widgets))).stdout, '');

    const fine = pending();
    assert.equal((await run(fine.home, submit(widgets, { session_id: 'a b; rm' }))).stdout, '');
    assert.equal((await run(fine.home, submit('relative/dir'))).stdout, '');
    assert.equal(
      (await run(fine.home, { ...submit(widgets), hook_event_name: 'Stop' })).stdout,
      '',
    );
    assert.equal(existsSync(fine.file), true);
  },
);

test(
  'listen-pending.sh: a prompt you did not type, or a subagent call, leaves the request alone',
  SKIP,
  async () => {
    const widgets = worktreeFixture().main;
    const { home, file } = pending();
    for (const prompt of [
      '<cross-session-message from="x">hi</cross-session-message>',
      '  <task-notification>done</task-notification>',
      '<agent-message>x</agent-message>',
      '<system-reminder>x</system-reminder>',
      'Another Claude session sent a message: hi',
      '[Cross-session idle notice] session x is idle',
      '[Subagent hand-back] it is done',
    ]) {
      const peer = await run(home, submit(widgets, { prompt }));
      assert.equal(peer.code, 0, prompt);
      assert.equal(peer.stdout, '', prompt);
      assert.equal(existsSync(file), true, prompt);
    }
    assert.equal(
      (await run(home, submit(widgets, { agent_id: 'abc', agent_type: 'x' }))).stdout,
      '',
    );
    assert.equal(existsSync(file), true);
    assert.match((await run(home, submit(widgets))).stdout, /acme\/widgets --keep/);
  },
);

test(
  'listen-pending.sh: a story with no origin matches by checkout, from a subfolder, and the sentence names the story',
  SKIP,
  async () => {
    const checkout = tmp('bare-checkout');
    git(checkout, 'init', '-q');
    mkdirSync(path.join(checkout, 'pkg'));
    const { home, file } = pending(
      { repo: null, story: 'local-feat-x', checkout },
      'story-local-feat-x',
    );
    assert.equal((await run(home, submit(tmp('elsewhere')))).stdout, '');
    assert.equal(existsSync(file), true);
    const out = JSON.parse((await run(home, submit(path.join(checkout, 'pkg')))).stdout);
    assert.match(
      out.hookSpecificOutput.additionalContext,
      /arguments `--story local-feat-x --keep`\.$/,
    );
    assert.equal(existsSync(file), false);
  },
);

test('listen-pending.sh: it does nothing when no request is queued', SKIP, async () => {
  const home = tmp('listen-empty');
  mkdirSync(path.join(home, 'pending-listen'));
  writeFileSync(path.join(home, 'pending-listen', 'note.txt'), 'x');
  const out = await run(home, submit('/tmp'), { PATH: '/usr/bin:/bin' });
  assert.equal(out.code, 0);
  assert.equal(out.stdout, '');
});

test(
  'listen-pending.sh: a lapsed request is removed without asking git for the origin',
  SKIP,
  async () => {
    const widgets = worktreeFixture().main;
    const bin = tmp('listen-shim');
    const marker = path.join(bin, 'git-ran');
    const shim = path.join(bin, 'git');
    writeFileSync(
      shim,
      `#!/bin/sh\ntouch '${marker}'\nexec '${execFileSync('which', ['git']).toString().trim()}' "$@"\n`,
    );
    chmodSync(shim, 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}` };
    const old = pending({ expires: Date.now() - 1000 });
    const out = await run(old.home, submit(widgets), env);
    assert.equal(out.stdout, '');
    assert.equal(existsSync(old.file), false);
    assert.equal(existsSync(marker), false, 'nothing live to match: git is not run');
    // a live request does ask
    const live = pending();
    assert.match((await run(live.home, submit(widgets), env)).stdout, /acme\/widgets --keep/);
    assert.equal(existsSync(marker), true);
  },
);
