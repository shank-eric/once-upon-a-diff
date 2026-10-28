import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmp, git, startBridge, localRepo, writeJson, TOKEN } from './helpers.ts';
import { createLocalStory } from '../src/stories/local-story.ts';
import { StoryStore } from '../src/stories/store.ts';
import { readSettings, shipRuleFor } from '../src/config/settings.ts';
import { shipMode } from '../src/stories/push-default.ts';
import { boardKey, pageKey, viewKey, viewKeyMay } from '../src/server/page-key.ts';
import type { BoardData, PushAnswer, PushView, StoryData } from '@once-upon-a-diff/shared/types';

const GITHUB_URL = 'https://github.com/acme/widgets.git';
const commit = (repo: string, name: string) => {
  writeFileSync(path.join(repo, name), `${name}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', name);
};

/**
 * A stand-in gh for the two GETs the push makes, `gh api repos/acme/widgets/branches/master/protection` and
 * `.../rules/branches/master`, answering from the `protection` and `rules` files next to it. It logs every call.
 */
const fake = (() => {
  const dir = tmp('gh');
  const bin = path.join(dir, 'gh');
  writeFileSync(
    bin,
    `#!/bin/sh
dir="$(dirname "$0")"
echo "$@" >> "$dir/calls"
[ "$1" = "api" ] || exit 2
case "$2" in
  */protection)
    case "$(cat "$dir/protection")" in
      none) echo "gh: Branch not protected (HTTP 404)" >&2; exit 1;;
      pr) echo '{"required_pull_request_reviews":{"required_approving_review_count":1}}'; exit 0;;
      denied) echo "gh: Resource not accessible by personal access token (HTTP 403)" >&2; exit 1;;
    esac;;
  */rules/branches/*) cat "$dir/rules"; exit 0;;
esac
exit 2
`,
  );
  chmodSync(bin, 0o755);
  const set = (protection: string, rules: unknown[] = []) => {
    writeFileSync(path.join(dir, 'protection'), protection);
    writeFileSync(path.join(dir, 'rules'), JSON.stringify(rules));
  };
  set('none');
  const calls = () => {
    try {
      return readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };
  return { bin, set, calls };
})();

let ghWas: string | undefined;
before(() => {
  ghWas = process.env.ONCE_UPON_GH;
  process.env.ONCE_UPON_GH = fake.bin;
});
after(() => {
  if (ghWas === undefined) {
    delete process.env.ONCE_UPON_GH;
  } else {
    process.env.ONCE_UPON_GH = ghWas;
  }
});

/**
 * A checkout on master whose origin (github.com/acme/widgets, rewritten to a bare repo) has master at A, with B and C
 * made since, and a local story of A..HEAD (so on branch master). `approve` approves it at C.
 */
async function setup(opts: { config?: Record<string, unknown> } = {}) {
  const home = tmp('home');
  if (opts.config) {
    writeJson(path.join(home, 'config.json'), { port: 1, token: TOKEN, ...opts.config });
  }
  const repo = tmp('ship-repo');
  const remote = tmp('ship-remote');
  git(remote, 'init', '-q', '--bare', '-b', 'master');
  git(repo, 'init', '-q', '-b', 'master');
  commit(repo, 'a.txt');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'config', `url.${remote}.insteadOf`, GITHUB_URL);
  git(repo, 'remote', 'add', 'origin', GITHUB_URL);
  git(repo, 'push', '-q', 'origin', 'master');
  git(repo, 'fetch', '-q', 'origin');
  commit(repo, 'b.txt');
  commit(repo, 'c.txt');
  const chapters = path.join(tmp('ch'), 'chapters.json');
  writeJson(chapters, { chapters: [{ title: 'Chapter 1', files: ['b.txt', 'c.txt'] }] });
  const story = createLocalStory({ home, repo, base, head: 'HEAD', chapters });
  const metaFile = path.join(story.dir, 'meta.json');
  writeJson(metaFile, { ...JSON.parse(readFileSync(metaFile, 'utf8')), repo: 'acme/widgets' });
  const bridge = await startBridge({ home });
  const id = story.id;
  const asKey = (key: string, method: string, route: string, body?: unknown) =>
    bridge.call(method, `/api/stories/${id}${route}`, body, { Authorization: `Bearer ${key}` });
  const full = <T>(method: string, route: string, body?: unknown) =>
    asKey(pageKey(TOKEN, id), method, route, body) as Promise<{
      status: number;
      text: string;
      body: T;
    }>;
  const head = () => git(repo, 'rev-parse', 'HEAD');
  const originMaster = () => git(remote, 'rev-parse', 'master');
  const approve = () => full('POST', '/approve', { approved: true, head_sha: head() });
  return {
    home,
    repo,
    remote,
    base,
    id,
    bridge,
    full,
    asKey,
    head,
    originMaster,
    approve,
    store: new StoryStore({ home }),
  };
}

test('Push fast-forwards the approved commit to origin, never beyond it, and the delivered check clears the card', async () => {
  fake.set('none');
  const { id, bridge, full, head, originMaster, approve, repo, remote, base, store } =
    await setup();
  try {
    const noApproval = await full<PushView>('GET', '/push');
    assert.equal(noApproval.status, 200);
    assert.match(noApproval.body.blocker as string, /Approve the story first/);
    assert.equal((await full('POST', '/push', { action: 'push', head_sha: head() })).status, 409);
    assert.equal(originMaster(), base, 'nothing was pushed');

    assert.equal((await approve()).status, 200);
    const approved = head();
    commit(repo, 'd.txt'); // made after Approve: not approved, so it stays local
    const view = (await full<PushView>('GET', '/push')).body;
    assert.equal(view.repo, 'acme/widgets');
    assert.equal(view.branch, 'master');
    assert.equal(view.approved_sha, approved);
    assert.equal(view.later, 1);
    assert.equal(view.remote.state, 'ahead');
    assert.deepEqual(
      view.to_push.map((one) => one.subject),
      ['c.txt', 'b.txt'],
    );
    assert.equal(view.blocker, null);
    assert.equal(view.protection.state, 'open');

    const wrong = await full('POST', '/push', { action: 'push', head_sha: head() });
    assert.equal(wrong.status, 409, 'only the approved commit the box showed');
    assert.equal((await full('POST', '/push', { action: 'nope' })).status, 400);
    assert.equal(originMaster(), base);

    const done = await full<PushAnswer>('POST', '/push', { action: 'push', head_sha: approved });
    assert.equal(done.status, 200, done.text);
    assert.equal(originMaster(), approved, 'origin has the approved commit and not d.txt');
    assert.notEqual(head(), approved);
    assert.ok(git(remote, 'log', '--format=%s', 'master').includes('b.txt'));
    assert.ok(!git(remote, 'log', '--format=%s', 'master').includes('d.txt'));
    // the story's head moved on (d.txt), so the approval is gone and the story is back in review
    assert.equal(store.readState(id, 'approved.json', null), null);
    assert.ok(!fake.calls().some((call) => /--method|-X/.test(call)), 'gh was only read from');
    assert.ok(fake.calls().every((call) => call.startsWith('api repos/acme/widgets/')));
  } finally {
    await bridge.close();
  }
});

test('pushing the story head: the push clears its card as delivered, and Ready to ship shows how it ships', async () => {
  fake.set('none');
  const { id, bridge, full, originMaster, approve, head, store } = await setup();
  try {
    await approve();
    const asBoard = () =>
      bridge
        .call<BoardData>('GET', '/api/board', undefined, {
          Authorization: `Bearer ${boardKey(TOKEN)}`,
        })
        .then((answer) =>
          answer.body.lanes.flatMap((lane) => lane.cards).find((card) => card.story?.id === id),
        );
    const before = await asBoard();
    assert.equal(before?.column, 'ship');
    assert.equal(before?.story?.ship, 'push');
    const done = await full<PushAnswer>('POST', '/push', {
      action: 'push',
      head_sha: head(),
    });
    assert.equal(done.status, 200, done.text);
    assert.equal(originMaster(), head());
    const marked = store.readState<{ by?: string } | null>(id, 'reviewed.json', null);
    assert.equal(marked?.by, 'delivered');
    assert.equal(store.readState(id, 'approved.json', null), null);
    await new Promise((resolve) => setTimeout(resolve, 2100)); // the board's snapshot is kept 2 s
    const after = await asBoard();
    assert.notEqual(after?.column, 'ship', 'the card is cleared');
    const data = (await full<StoryData>('GET', '')).body;
    assert.equal(data.local?.approved, null);
  } finally {
    await bridge.close();
  }
});

test('a remote with commits the checkout lacks is refused, and nothing is forced', async () => {
  fake.set('none');
  const { bridge, full, originMaster, approve, head, remote, base } = await setup();
  try {
    await approve();
    // someone else pushed to master
    const other = tmp('other');
    execFileSync('git', ['clone', '-q', remote, other]);
    commit(other, 'theirs.txt');
    git(other, 'push', '-q', 'origin', 'master');
    const theirs = originMaster();
    assert.notEqual(theirs, base);
    const view = (await full<PushView>('GET', '/push')).body;
    assert.equal(view.remote.state, 'diverged');
    assert.match(view.blocker as string, /has commits this checkout's doesn't/);
    assert.equal(view.pr_instead, false);
    const refused = await full('POST', '/push', { action: 'push', head_sha: head() });
    assert.equal(refused.status, 409);
    assert.equal(originMaster(), theirs, 'origin is as they left it');
  } finally {
    await bridge.close();
  }
});

test('an approved commit that is not on the local default branch is refused', async () => {
  fake.set('none');
  const { bridge, full, originMaster, approve, head, repo, base } = await setup();
  try {
    await approve();
    const approved = head();
    git(repo, 'reset', '-q', '--hard', 'HEAD~1'); // master no longer has the approved commit
    const view = (await full<PushView>('GET', '/push')).body;
    assert.match(view.blocker as string, /isn't on this checkout's master/);
    const refused = await full('POST', '/push', { action: 'push', head_sha: approved });
    assert.equal(refused.status, 409);
    assert.equal(originMaster(), base);
  } finally {
    await bridge.close();
  }
});

test('a protected branch, a ruleset that requires pull requests, or protection gh cannot read refuses the push', async () => {
  const { bridge, full, originMaster, approve, head, base } = await setup();
  try {
    await approve();
    const attempt = async () => {
      const view = (await full<PushView>('GET', '/push')).body;
      const refused = await full('POST', '/push', { action: 'push', head_sha: head() });
      assert.equal(refused.status, 409);
      assert.equal(originMaster(), base, 'nothing was pushed');
      return view;
    };

    fake.set('pr');
    let view = await attempt();
    assert.equal(view.protection.state, 'protected');
    assert.match(view.blocker as string, /requires pull requests/);
    assert.equal(view.pr_instead, true, 'the box offers Create pull request');

    fake.set('none', [{ type: 'pull_request', parameters: {} }]);
    view = await attempt();
    assert.equal(view.protection.state, 'protected');
    assert.match(view.blocker as string, /ruleset/);
    assert.equal(view.pr_instead, true);

    fake.set('none', [{ type: 'deletion' }]);
    view = await full<PushView>('GET', '/push').then((answer) => answer.body);
    assert.equal(view.protection.state, 'open', 'a ruleset that only stops deletions is no bar');
    assert.equal(view.blocker, null);

    fake.set('denied');
    view = await attempt();
    assert.equal(view.protection.state, 'unknown', 'never assumed open');
    assert.equal(view.pr_instead, false);
  } finally {
    await bridge.close();
  }
});

test('the ship rules: first matching glob on owner/name wins, case does not matter, and bad entries are dropped', () => {
  const home = tmp('home');
  writeJson(path.join(home, 'config.json'), {
    port: 1,
    token: TOKEN,
    ship: {
      'shank-eric/Configuration': 'push',
      'EverFi/*': 'pr',
      '*/*': 'Push',
      'no-slash': 'push',
      'a/b': 'merge',
    },
  });
  const { ship } = readSettings(home);
  assert.deepEqual(ship, [
    { pattern: 'shank-eric/Configuration', mode: 'push' },
    { pattern: 'EverFi/*', mode: 'pr' },
    { pattern: '*/*', mode: 'push' },
  ]);
  assert.equal(shipRuleFor('shank-eric/configuration', ship), 'push');
  assert.equal(shipRuleFor('everfi/HomeRoom', ship), 'pr');
  assert.equal(shipRuleFor('acme/widgets', ship), 'push', 'the catch-all, last');
  assert.equal(shipRuleFor('EverFi/a/b', ship), null, '* stays within one part');
  assert.equal(shipRuleFor(null, ship), null);
  assert.equal(shipRuleFor('x/y', []), null);
  assert.equal(shipRuleFor('EverFi.x/y', [{ pattern: 'EverFi.x/*', mode: 'pr' }]), 'pr');
  assert.equal(
    shipRuleFor('EverFiXx/y', [{ pattern: 'EverFi.x/*', mode: 'pr' }]),
    null,
    'a dot is a dot',
  );
  assert.deepEqual(readSettings(tmp('none')).ship, []);
});

test('which button a story gets: by branch, a commit range on the default branch, and the ship rules over both', async () => {
  const { home, repo, bridge, base, full } = await setup();
  try {
    const meta = (extra = {}) => ({
      kind: 'local' as const,
      repo: 'acme/widgets',
      repo_path: repo,
      branch: 'master',
      head_oid: git(repo, 'rev-parse', 'HEAD'),
      ...extra,
    });
    assert.equal(shipMode(meta(), home), 'push', 'a story on the default branch');
    assert.equal(shipMode(meta({ branch: 'feature/x' }), home), 'pr', 'any other branch');
    // no recorded branch: a commit at a time. On master it pushes; a commit that is not on master does not
    assert.equal(shipMode(meta({ branch: null }), home), 'push');
    git(repo, 'checkout', '-q', '-b', 'topic', base);
    commit(repo, 'topic.txt');
    assert.equal(
      shipMode(meta({ branch: null, head_oid: git(repo, 'rev-parse', 'HEAD') }), home),
      'pr',
    );
    git(repo, 'checkout', '-q', 'master');
    // the page's story data carries it
    assert.equal((await full<StoryData>('GET', '')).body.local?.ship, 'push');
    // a local story built from a sha with no branch, whose head is on master
    const chapters = path.join(tmp('ch'), 'chapters.json');
    writeJson(chapters, { chapters: [{ title: 'Chapter 1', files: ['b.txt'] }] });
    const sha = createLocalStory({
      home,
      repo,
      base,
      head: git(repo, 'rev-parse', 'HEAD'),
      chapters,
    });
    const raw = JSON.parse(readFileSync(path.join(sha.dir, 'meta.json'), 'utf8'));
    assert.equal(raw.branch, null);
    assert.equal(shipMode({ ...raw, repo: 'acme/widgets' }, home), 'push');
    // the rules: Push on a feature branch, Create pull request on the default branch
    writeJson(path.join(home, 'config.json'), {
      port: 1,
      token: TOKEN,
      ship: { 'acme/widgets': 'pr' },
    });
    assert.equal(shipMode(meta(), home), 'pr', 'a rule beats the branch');
    assert.equal((await full<StoryData>('GET', '')).body.local?.ship, 'pr');
    writeJson(path.join(home, 'config.json'), {
      port: 1,
      token: TOKEN,
      ship: { 'ACME/*': 'push' },
    });
    assert.equal(shipMode(meta({ branch: 'feature/x' }), home), 'push');
  } finally {
    await bridge.close();
  }
});

test('only the full page key reaches Push: not the read-only key, the board key, another story, or a PR story', async () => {
  fake.set('none');
  const { id, bridge, asKey, approve, head, originMaster, base, full } = await setup();
  try {
    await approve();
    // the read-only key's list has no push, in either direction
    assert.equal(viewKeyMay('push', 'GET'), false);
    assert.equal(viewKeyMay('push', 'POST'), false);
    for (const key of [
      viewKey(TOKEN, id),
      boardKey(TOKEN),
      pageKey(TOKEN, 'other'),
      'page.nonsense',
    ]) {
      const read = await asKey(key, 'GET', '/push');
      assert.equal(read.status, 403, `GET ${read.text}`);
      const write = await asKey(key, 'POST', '/push', { action: 'push', head_sha: head() });
      assert.equal(write.status, 403, `POST ${write.text}`);
    }
    assert.equal(originMaster(), base, 'nothing was pushed');
    // the read-only key still reads the story, which says how it ships
    const data = await asKey(viewKey(TOKEN, id), 'GET', '');
    assert.equal(data.status, 200);
    assert.equal((data.body as StoryData).local?.ship, 'push');
    assert.equal((await full('GET', '/push')).status, 200);
    const pr = await bridge.call('POST', '/api/stories/acme-widgets-7/push', {
      action: 'push',
    });
    assert.ok([400, 404].includes(pr.status), 'a PR story is not pushed from here');
  } finally {
    await bridge.close();
  }
});

test('a checkout whose origin is not on GitHub gets a reason, not a push', async () => {
  const { bridge, full } = await (async () => {
    const home = tmp('home');
    const { repo, base } = localRepo(); // on branch feature, with no origin
    const chapters = path.join(tmp('ch'), 'chapters.json');
    writeJson(chapters, { chapters: [{ title: 'Chapter 1', files: ['one.txt'] }] });
    const story = createLocalStory({ home, repo, base, head: 'HEAD', chapters });
    const bridge = await startBridge({ home });
    const full = (method: string, route: string, body?: unknown) =>
      bridge.call<PushView>(method, `/api/stories/${story.id}${route}`, body, {
        Authorization: `Bearer ${pageKey(TOKEN, story.id)}`,
      });
    return { bridge, full };
  })();
  try {
    const view = await full('GET', '/push');
    assert.equal(view.status, 200);
    assert.match(view.body.blocker as string, /isn't a GitHub repo|origin's default/);
  } finally {
    await bridge.close();
  }
});
