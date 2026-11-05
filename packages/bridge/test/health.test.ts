import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmp, githubStory, startBridge, git } from './helpers.ts';
import os from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  beat,
  listeners,
  cliCommand,
  listenPrompt,
  type statusOf,
} from '@once-upon-a-diff/core/records/listeners/listeners';
import {
  repoOfCheckout,
  repoOfCheckoutAsync,
  forgetRepoLookups,
  lastKnownRepo,
  repoOfRemote,
  parseRemote,
  remoteNamed,
  checkoutFor,
  seenCheckout,
} from '@once-upon-a-diff/core/foundation/repos';
import { doctor } from '@once-upon-a-diff/core/orchestration/bridge/doctor';

/** GET /api/status. */
type Status = ReturnType<typeof statusOf>;

test('a fresh waiting beat counts as listening, a stale one or a dead process does not, and a handling beat lasts longer', () => {
  const home = tmp('home');
  beat(home, 'once-upon', 'waiting');
  assert.equal(listeners(home)[0].live, true);
  assert.equal(
    listeners(home, Date.now() + 16000)[0].live,
    false,
    'a waiting beat goes stale after 15s',
  );
  mkdirSync(path.join(home, 'listeners'), { recursive: true });
  writeFileSync(
    path.join(home, 'listeners', 'gone.json'),
    JSON.stringify({
      consumer: 'gone',
      pid: 999999,
      state: 'waiting',
      at: new Date().toISOString(),
    }),
  );
  assert.equal(
    listeners(home).find((listener) => listener.consumer === 'gone')!.live,
    false,
    'a dead process is not listening',
  );
  beat(home, 'busy', 'handling', { question: 'q_1' });
  assert.equal(
    listeners(home, Date.now() + 5 * 60000).find((listener) => listener.consumer === 'busy')!.live,
    true,
    'answering counts for a while',
  );
});

test('/api/status reports the bridge, the story and listening', async () => {
  const home = tmp('home');
  githubStory(path.join(home, 'acme-widgets-7'));
  const bridge = await startBridge({ home });
  try {
    let status = (await bridge.call<Status>('GET', '/api/status?story=acme-widgets-7')).body;
    assert.equal(status.bridge.ok, true);
    assert.deepEqual(status.story, { ok: true, id: 'acme-widgets-7' });
    assert.equal(status.listening.ok, false);
    assert.match(status.listening.start, /once-upon-listen/);
    assert.equal(
      (await bridge.call<Status>('GET', '/api/status?story=nope')).body.story!.ok,
      false,
    );
    beat(home, 'once-upon');
    status = (await bridge.call<Status>('GET', '/api/status?story=acme-widgets-7')).body;
    assert.equal(status.listening.ok, true);
    assert.equal(status.story!.id, 'acme-widgets-7');
    assert.equal(
      (await bridge.call('GET', '/api/status', undefined, { Authorization: 'Bearer wrong' }))
        .status,
      401,
    );
    await bridge.call('GET', '/api/health', undefined, {
      Origin: 'chrome-extension://faaibhigocihefldbmdgchcnnclalkmo',
    });
    assert.ok(
      existsSync(path.join(home, 'extension-seen.json')),
      'the bridge notes when the extension talks to it',
    );
  } finally {
    await bridge.close();
  }
});

test('doctor reports a missing bridge as failing, with the fix', async () => {
  const home = tmp('home');
  const lines: string[] = [];
  const ok = await doctor(home, { token: 't', port: 1 }, { out: (line) => lines.push(line) });
  assert.equal(ok, false);
  const text = lines.join('\n');
  assert.match(text, /FAIL\s+Bridge: nothing is listening on 127\.0\.0\.1:1/);
  assert.match(text, /fix: Start it: once-upon serve/);
  assert.match(text, /WARN\s+Claude listening/);
  assert.ok(text.includes(`PASS  Node: v${process.versions.node} at ${process.execPath}`));
});

test('doctor fails a Node older than 24, with the fix', async () => {
  const lines: string[] = [];
  const ok = await doctor(
    tmp('home'),
    { token: 't', port: 1 },
    { nodeVersion: '22.15.0', out: (line) => lines.push(line) },
  );
  assert.equal(ok, false);
  const text = lines.join('\n');
  assert.match(text, /FAIL\s+Node: v22\.15\.0 at .+, needs 24 or newer/);
  assert.match(text, /fix: Run fnm use or nvm use/);
});

test('doctor passes the bridge when it is up', async () => {
  const home = tmp('home');
  const bridge = await startBridge({ home });
  try {
    const lines: string[] = [];
    await doctor(
      home,
      {
        token: 'test-token-0123456789abcdef',
        port: (bridge.server.address() as AddressInfo).port,
      },
      { out: (line) => lines.push(line) },
    );
    assert.match(lines.join('\n'), /PASS\s+Bridge: running on 127\.0\.0\.1:\d+, version/);
  } finally {
    await bridge.close();
  }
});

test('doctor --wait gives a bridge that was just started time to answer', async () => {
  const home = tmp('home');
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  const late = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, name: 'once-upon-bridge', version: 'test' }));
  });
  setTimeout(() => late.listen(port, '127.0.0.1'), 700);
  try {
    const lines: string[] = [];
    await doctor(home, { token: 't', port }, { wait: 5, out: (line) => lines.push(line) });
    assert.match(lines.join('\n'), /PASS\s+Bridge: running on 127\.0\.0\.1:\d+, version test/);
  } finally {
    await new Promise((resolve) => late.close(resolve));
  }
});

test('the listen prompt: one short skill line naming the repo, with the long form behind it', async () => {
  const prompt = listenPrompt(
    { repo: 'octo-org/api-server', checkout: path.join(os.homedir(), 'Development', 'api-server') },
    'once-upon',
  );
  assert.equal(prompt.prompt, '/once-upon-listen octo-org/api-server');
  assert.equal(prompt.command, 'once-upon wait --repo octo-org/api-server');
  assert.equal(prompt.checkout, '~/Development/api-server');
  assert.match(
    prompt.details,
    /^In ~\/Development\/api-server, run `once-upon wait --repo octo-org\/api-server` as a background task/,
  );
  for (const bit of [
    'once-upon answer --question <id>',
    '/once-upon <PR url>',
    'once-upon done <id> --failed',
  ]) {
    assert.ok(prompt.details.includes(bit), bit);
  }
  assert.equal(
    listenPrompt({ story: 'local-x' }, 'once-upon').prompt,
    '/once-upon-listen --story local-x',
    '--story still works, for a story with no GitHub repo',
  );
  assert.match(
    listenPrompt({ repo: 'a/b' }, 'once-upon').details,
    /^In your checkout of a\/b, run/,
  );

  assert.equal(cliCommand(true), 'once-upon');
  const full = cliCommand(false);
  assert.ok(full.startsWith(process.execPath), 'off PATH it names node by full path');
  assert.match(full, /\/bridge\/bin\/once-upon\.mjs$/);

  const home = tmp('home');
  githubStory(path.join(home, 'acme-widgets-7'));
  const bridge = await startBridge({ home });
  try {
    let status = (await bridge.call<Status>('GET', '/api/status?story=acme-widgets-7')).body;
    assert.equal(status.repo, 'acme/widgets', "the page's repo comes from its story");
    assert.equal(status.listening.prompt, '/once-upon-listen acme/widgets');
    beat(home, 'repo-acme-gadgets', 'waiting', { repo: 'acme/gadgets' });
    assert.equal(
      (await bridge.call<Status>('GET', '/api/status?story=acme-widgets-7')).body.listening.ok,
      false,
      "another repo's listener doesn't count",
    );
    beat(home, 'repo-acme-widgets', 'waiting', { repo: 'ACME/Widgets' });
    status = (await bridge.call<Status>('GET', '/api/status?repo=acme/widgets')).body;
    assert.equal(status.listening.ok, true, 'a PR page with no story, by ?repo=');
    assert.equal(status.listening.consumers[0].repo, 'ACME/Widgets');
  } finally {
    await bridge.close();
  }
});

test('a checkout’s repo, looked up without blocking: timed out, kept per folder (failures too) until it expires, shared while running', async () => {
  forgetRepoLookups();
  const calls: { dir: string; args: string[]; timeout?: number }[] = [];
  let reply: { code: number; stdout: string; stderr: string } = {
    code: 0,
    stdout: 'git@github.com:octo-org/api-server.git\n',
    stderr: '',
  };
  let clock = 1000;
  const options = {
    ttlMs: 5000,
    timeoutMs: 1234,
    now: () => clock,
    run: async (dir: string, args: string[], extra?: { timeout?: number }) => {
      calls.push({ dir, args, timeout: extra?.timeout });
      await new Promise((resolve) => setImmediate(resolve));
      return reply;
    },
  };
  const [one, two] = await Promise.all([
    repoOfCheckoutAsync('/a', options),
    repoOfCheckoutAsync('/a', options),
  ]);
  assert.deepEqual([one, two], ['octo-org/api-server', 'octo-org/api-server']);
  assert.equal(calls.length, 1, 'callers while it runs share one look');
  assert.deepEqual(
    calls[0].args,
    ['remote', 'get-url', 'origin'],
    'git by argument list, no shell',
  );
  assert.equal(calls[0].timeout, 1234, 'with the timeout');
  assert.equal(await repoOfCheckoutAsync('/a', options), 'octo-org/api-server');
  assert.equal(calls.length, 1, 'kept');
  assert.equal(lastKnownRepo('/a'), 'octo-org/api-server');
  assert.equal(lastKnownRepo('/never'), undefined);
  // a failure (a timeout is one) is kept too, so a hung mount is not asked every poll
  reply = { code: 1, stdout: '', stderr: 'timed out' };
  assert.equal(await repoOfCheckoutAsync('/b', options), null);
  assert.equal(await repoOfCheckoutAsync('/b', options), null);
  assert.equal(calls.length, 2);
  // past the expiry it looks again, so a fixed remote is picked up
  clock += 5000;
  reply = { code: 0, stdout: 'https://github.com/octo-org/web.git', stderr: '' };
  assert.equal(await repoOfCheckoutAsync('/b', options), 'octo-org/web');
  assert.equal(calls.length, 3);
  assert.equal(await repoOfCheckoutAsync(null, options), null);
  assert.equal(calls.length, 3);
  // a run that throws still answers null
  forgetRepoLookups();
  const broken = { ...options, run: () => Promise.reject(new Error('boom')) };
  assert.equal(await repoOfCheckoutAsync('/c', broken), null);
  forgetRepoLookups();
});

test('the checkout to work from: one the bridge has seen, else ~/Development/<name> if its origin matches', async () => {
  const home = tmp('home');
  const dev = tmp('dev');
  const repo = path.join(dev, 'api-server');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'remote', 'add', 'origin', 'git@github.com:octo-org/api-server.git');
  assert.equal(repoOfCheckout(repo), 'octo-org/api-server');
  assert.equal(checkoutFor(home, 'octo-org/api-server', { dev }), repo);
  assert.equal(checkoutFor(home, 'octo-org/nope', { dev }), null);
  const worktree = tmp('wt');
  seenCheckout(home, 'octo-org/api-server', worktree);
  assert.equal(
    checkoutFor(home, 'octo-org/api-server', { dev }),
    worktree,
    'a seen checkout comes first',
  );
  assert.equal(repoOfRemote('https://github.com/octo-org/web-app.git'), 'octo-org/web-app');
  assert.equal(repoOfRemote('https://gitlab.com/a/b'), null);
});

test('repoOfRemote is GitHub only: another host gives null, so nothing reaches gh or github.com with it', () => {
  const cases: Array<[string | null | undefined, string | null]> = [
    ['https://github.com/octo-org/web-app.git', 'octo-org/web-app'],
    ['https://github.com/octo-org/web-app/', 'octo-org/web-app'],
    ['https://user:token@github.com/octo-org/web-app', 'octo-org/web-app'],
    ['git@github.com:octo-org/api-server.git', 'octo-org/api-server'],
    ['ssh://git@github.com/octo-org/api-server.git', 'octo-org/api-server'],
    ['ssh://git@ssh.github.com:443/octo-org/api-server.git', 'octo-org/api-server'],
    ['  https://github.com/o/n.git\n', 'o/n'],
    ['https://ghe.example.com/octo-org/web-app.git', null],
    ['git@ghe.example.com:octo-org/web-app.git', null],
    ['https://gitlab.com/a/b', null],
    ['https://gitlab.com/group/sub/repo', null],
    ['https://dev.azure.com/everfi-dev/Platform/_git/dashifi', null],
    ['git@ssh.dev.azure.com:v3/everfi-dev/Platform/dashifi', null],
    ['https://evilgithub.com/o/n', null],
    ['https://github.com/o/n/extra', null],
    ['https://github.com/only-owner', null],
    ['/srv/git/o/n.git', null],
    ['file:///srv/git/o/n.git', null],
    ['', null],
    [null, null],
    [undefined, null],
  ];
  for (const [url, repo] of cases) {
    assert.equal(repoOfRemote(url), repo, String(url));
  }
});

test('parseRemote reads any host and form, with one identity per repo', () => {
  const remote = (host: string, owner: string, name: string) => ({ host, owner, name });
  const cases: Array<[string, ReturnType<typeof parseRemote>]> = [
    ['https://github.com/octo-org/web-app.git', remote('github.com', 'octo-org', 'web-app')],
    [
      'https://user:token@GHE.example.com:8443/octo-org/web-app',
      remote('ghe.example.com', 'octo-org', 'web-app'),
    ],
    [
      'https://ghe.example.com/git/octo-org/web-app.git',
      remote('ghe.example.com', 'git/octo-org', 'web-app'),
    ],
    ['git@ghe.example.com:octo-org/web-app.git', remote('ghe.example.com', 'octo-org', 'web-app')],
    [
      'ssh://git@ghe.example.com:2222/octo-org/web-app.git',
      remote('ghe.example.com', 'octo-org', 'web-app'),
    ],
    [
      'ssh://ghe.example.com:2222/octo-org/web-app',
      remote('ghe.example.com', 'octo-org', 'web-app'),
    ],
    ['https://gitlab.com/group/sub/repo.git', remote('gitlab.com', 'group/sub', 'repo')],
    // Azure DevOps: every form of one repo is the same identity, and no `_git` owner
    [
      'https://dev.azure.com/everfi-dev/Platform/_git/dashifi',
      remote('dev.azure.com', 'everfi-dev/Platform', 'dashifi'),
    ],
    [
      'https://everfi-dev@dev.azure.com/everfi-dev/Platform/_git/dashifi',
      remote('dev.azure.com', 'everfi-dev/Platform', 'dashifi'),
    ],
    [
      'git@ssh.dev.azure.com:v3/everfi-dev/Platform/dashifi',
      remote('ssh.dev.azure.com', 'everfi-dev/Platform', 'dashifi'),
    ],
  ];
  for (const [url, expected] of cases) {
    assert.deepEqual(parseRemote(url), expected, url);
  }
  for (const url of [
    'https://github.com/only-owner',
    '/srv/git/o/n',
    'C:/x/y',
    'file:///srv/o/n',
    '',
    null,
    undefined,
  ]) {
    assert.equal(parseRemote(url), null, String(url));
  }
});

test('GitHub host aliases, the _git name and underscore aliases', () => {
  assert.equal(repoOfRemote('git@work.github.com:o/n.git'), 'o/n');
  assert.equal(repoOfRemote('git@ssh.github.com:o/n.git'), 'o/n');
  assert.equal(repoOfRemote('git@github.example.com:o/n.git'), null);
  assert.equal(repoOfRemote('https://github.example.com/o/n'), null);
  assert.equal(repoOfRemote('git@notgithub.com:o/n.git'), null);
  assert.equal(repoOfRemote('https://github.com/o/_git'), 'o/_git');
  assert.deepEqual(parseRemote('https://github.com/o/_git'), {
    host: 'github.com',
    owner: 'o',
    name: '_git',
  });
  assert.equal(parseRemote('https://dev.azure.com/org/proj/_git/repo')?.owner, 'org/proj');
  assert.equal(parseRemote('https://org.visualstudio.com/proj/_git/repo')?.owner, 'proj');
  assert.equal(parseRemote('git@github_work:o/n.git')?.name, 'n');
  assert.equal(repoOfRemote('git@github_work:o/n.git'), null);
  assert.equal(remoteNamed('git@github_work:o/n.git', 'o/n'), true);
  assert.equal(parseRemote('https://github_work/o/n'), null);
});

test('remoteNamed: the owner/name a registered --repo gives, on any host', () => {
  assert.equal(remoteNamed('https://ghe.example.com/Acme/widgets.git', 'acme/widgets'), true);
  assert.equal(remoteNamed('git@github.com:acme/widgets.git', 'acme/widgets'), true);
  assert.equal(
    remoteNamed('https://dev.azure.com/everfi-dev/Platform/_git/dashifi', 'Platform/dashifi'),
    true,
  );
  assert.equal(remoteNamed('https://ghe.example.com/other/thing.git', 'acme/widgets'), false);
  assert.equal(remoteNamed('https://ghe.example.com/acme/other.git', 'acme/widgets'), false);
  assert.equal(remoteNamed('/srv/git/acme/widgets', 'acme/widgets'), false);
  assert.equal(remoteNamed(null, 'acme/widgets'), false);
  assert.equal(remoteNamed('https://ghe.example.com/acme/widgets', null), false);
});
