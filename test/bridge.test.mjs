import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmp, githubStory, startBridge, TOKEN, localRepo, git, writeJson } from './helpers.mjs';
import { pathSha } from '../bridge/lib/diff.mjs';
import { createLocalStory } from '../bridge/lib/local.mjs';
import { StoryStore } from '../bridge/lib/stories.mjs';

/** A raw request, for headers fetch won't let us set (Host). */
function raw(base, p, headers) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: u.port, path: p, headers }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('bridge guard rails', () => {
  let b;
  before(async () => {
    const home = tmp('home');
    githubStory(path.join(home, 'acme-widgets-7'));
    b = await startBridge({ home });
  });
  after(() => b.close());

  test('binds to 127.0.0.1', () => {
    assert.equal(b.server.address().address, '127.0.0.1');
  });
  test('needs the token for /api', async () => {
    assert.equal(
      (await b.call('GET', '/api/stories', undefined, { Authorization: '' })).status,
      401,
    );
    assert.equal(
      (await b.call('GET', '/api/stories', undefined, { Authorization: 'Bearer nope' })).status,
      401,
    );
    assert.equal((await b.call('GET', '/api/stories')).status, 200);
  });
  test('refuses a foreign Host header (DNS rebinding)', async () => {
    const r = await raw(b.base, '/api/health', {
      Host: 'evil.example:80',
      Authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(r.status, 421);
  });
  test('refuses web page origins but takes the extension and its own pages', async () => {
    assert.equal(
      (await b.call('GET', '/api/health', undefined, { Origin: 'https://github.com' })).status,
      403,
    );
    assert.equal(
      (
        await b.call('GET', '/api/health', undefined, {
          Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
        })
      ).status,
      200,
    );
    assert.equal((await b.call('GET', '/api/health', undefined, { Origin: b.base })).status, 200);
  });
  test('writes must be JSON', async () => {
    const res = await fetch(`${b.base}/api/stories/acme-widgets-7/questions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/plain' },
      body: '{"text":"hi"}',
    });
    assert.equal(res.status, 415);
  });
  test('sends no CORS headers', async () => {
    const r = await b.call('GET', '/api/stories');
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  });
  test('rejects story ids that try to leave the root', async () => {
    assert.equal((await b.call('GET', '/api/stories/..%2F..%2Fetc')).status, 404);
    assert.equal((await b.call('GET', '/api/stories/.hidden')).status, 404);
  });
});

describe('GitHub stories', () => {
  let b, home;
  before(async () => {
    home = tmp('home');
    githubStory(path.join(home, 'acme-widgets-7'));
    b = await startBridge({ home });
  });
  after(() => b.close());

  test('lists and finds a story by repo and number, case-insensitively', async () => {
    const list = await b.call('GET', '/api/stories');
    assert.deepEqual(
      list.body.stories.map((s) => s.id),
      ['acme-widgets-7'],
    );
    const hit = await b.call('GET', '/api/stories/find?repo=ACME/Widgets&number=7');
    assert.equal(hit.status, 200);
    assert.equal(hit.body.id, 'acme-widgets-7');
    assert.equal((await b.call('GET', '/api/stories/find?repo=acme/widgets&number=8')).status, 404);
  });

  test('serves the panel data with GitHub anchors and an extra chapter for unplaced files', async () => {
    const { body } = await b.call('GET', '/api/stories/acme-widgets-7');
    assert.equal(body.kind, 'github');
    assert.equal(body.pr.url, 'https://github.com/acme/widgets/pull/7');
    assert.deepEqual(body.files.map((f) => f.rel).sort(), ['README.md', 'src/a.js', 'src/b.js']);
    assert.equal(body.files.find((f) => f.rel === 'src/a.js').sha, pathSha('src/a.js'));
    assert.equal(body.chapters.length, 3);
    assert.deepEqual(body.chapters[0].files[0], {
      rel: 'src/a.js',
      partial: true,
      note: 'the top',
      lines: [{ side: 'R', start: 1, end: 3, label: 'top' }],
    });
    assert.equal(body.chapters[2].title, 'Chapter 3: Not in a chapter yet');
    assert.deepEqual(
      body.chapters[2].files.map((f) => f.rel),
      ['README.md'],
    );
    assert.equal(body.local, undefined);
  });

  test('version changes when chapters.json does', async () => {
    const v1 = (await b.call('GET', '/api/stories/acme-widgets-7/version')).body.version;
    const file = path.join(home, 'acme-widgets-7', 'chapters.json');
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(file, readFileSync(file, 'utf8').replace('Story map', 'Story map, updated'));
    const v2 = (await b.call('GET', '/api/stories/acme-widgets-7/version')).body.version;
    assert.notEqual(v1, v2);
  });

  test('questions go to the inbox and come back with their answers', async () => {
    const q = await b.call('POST', '/api/stories/acme-widgets-7/questions', {
      text: '  Why is a.js split?  ',
      step: 1,
      chapter: 'Chapter 1: Start',
      file: 'src/a.js',
      url: 'https://github.com/acme/widgets/pull/7/changes',
    });
    assert.equal(q.status, 200);
    assert.match(q.body.id, /^q_/);
    assert.equal(q.body.text, 'Why is a.js split?');
    const lines = readFileSync(path.join(home, 'inbox.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    const logged = lines.find((e) => e.id === q.body.id);
    assert.equal(logged.type, 'question');
    assert.equal(logged.story, 'acme-widgets-7');
    assert.equal(logged.step, 1);
    assert.equal(
      (await b.call('POST', '/api/stories/acme-widgets-7/questions', { text: ' ' })).status,
      400,
    );

    const a = await b.call('POST', '/api/answers', {
      question: q.body.id,
      text: 'Because **chapter 2** finishes it.',
    });
    assert.equal(a.status, 200);
    const { body } = await b.call('GET', '/api/stories/acme-widgets-7/questions');
    const back = body.questions.find((x) => x.id === q.body.id);
    assert.equal(back.answers.length, 1);
    assert.equal(back.answers[0].text, 'Because **chapter 2** finishes it.');
  });

  test('positions are recorded, and only logged to the inbox when they change', async () => {
    const pos = { step: 2, chapter: 'Chapter 2: Finish', file: 'src/b.js' };
    assert.equal(
      (await b.call('POST', '/api/stories/acme-widgets-7/position', pos)).body.logged,
      true,
    );
    assert.equal(
      (await b.call('POST', '/api/stories/acme-widgets-7/position', pos)).body.logged,
      false,
    );
    assert.equal(
      (await b.call('POST', '/api/stories/acme-widgets-7/position', { ...pos, file: 'src/a.js' }))
        .body.logged,
      true,
    );
    const saved = JSON.parse(
      readFileSync(path.join(home, 'state', 'acme-widgets-7', 'position.json'), 'utf8'),
    );
    assert.equal(saved.file, 'src/a.js');
    const positions = readFileSync(path.join(home, 'inbox.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
      .filter((e) => e.type === 'position');
    assert.equal(positions.length, 2);
  });

  test('keeps the panel state per story', async () => {
    await b.call('POST', '/api/stories/acme-widgets-7/ui', { n: 2, collapsed: true, width: 500 });
    const { body } = await b.call('GET', '/api/stories/acme-widgets-7/ui');
    assert.equal(body.n, 2);
    assert.equal(body.collapsed, true);
    assert.equal(body.width, 500);
  });

  test('viewed and notes are only for local stories', async () => {
    assert.equal(
      (
        await b.call('POST', '/api/stories/acme-widgets-7/viewed', {
          path: 'src/a.js',
          viewed: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await b.call('POST', '/api/stories/acme-widgets-7/notes', {
          path: 'src/a.js',
          line: 1,
          body: 'x',
        })
      ).status,
      400,
    );
  });
});

describe('story discovery', () => {
  test('finds pr-story scratch folders, and the home copy wins over scratch', () => {
    const home = tmp('home');
    const scratch = tmp('scratch');
    githubStory(path.join(scratch, 'proj', 'sess', 'scratchpad', 'pr-story', 'widgets-7'));
    githubStory(path.join(scratch, 'proj', 'sess2', 'scratchpad', 'pr-story', 'acme-widgets-7'));
    githubStory(path.join(home, 'acme-widgets-7'));
    const store = new StoryStore({ home, scratch: [scratch] });
    const list = store.list();
    assert.deepEqual(list.map((s) => s.id).sort(), ['acme-widgets-7', 'widgets-7']);
    assert.equal(
      list.find((s) => s.id === 'acme-widgets-7').dir,
      path.join(home, 'acme-widgets-7'),
    );
    assert.ok(store.find('acme/widgets', 7));
  });
  test('ignores folders without chapters.json', () => {
    const home = tmp('home');
    writeJson(path.join(home, 'state', 'x', 'ui.json'), {});
    writeJson(path.join(home, 'half', 'meta.json'), { kind: 'github' });
    assert.deepEqual(new StoryStore({ home, scratch: false }).list(), []);
  });
});

describe('local stories', () => {
  let b, home, repo, base, id;
  before(async () => {
    home = tmp('home');
    ({ repo, base } = localRepo());
    const chapters = path.join(tmp('ch'), 'chapters.json');
    writeJson(chapters, {
      title: 'Two commits',
      chapters: [
        {
          title: 'Chapter 1: One',
          files: ['one.txt'],
          comments: [{ path: 'one.txt', line: 2, body: 'Fix the capital B' }],
        },
        { title: 'Chapter 2: Two', files: ['lib/two.js', 'not-in-diff.js'] },
      ],
    });
    const made = createLocalStory({ home, repo, base, head: 'HEAD', chapters });
    id = made.id;
    assert.equal(made.files, 3);
    assert.deepEqual(made.unplaced, ['gone.txt']);
    assert.deepEqual(made.unknown, ['not-in-diff.js']);
    b = await startBridge({ home });
  });
  after(() => b.close());

  test('is named for the repo and branch', () => {
    assert.match(id, /^local-diff-story-repo-.+-feature$/);
  });

  test('serves the diff with hunks, and drops chapter files that are not in it', async () => {
    const { body } = await b.call('GET', `/api/stories/${id}`);
    assert.equal(body.kind, 'local');
    assert.equal(body.local.base_oid, base);
    assert.equal(body.local.commits.length, 2);
    const one = body.local.files.find((f) => f.rel === 'one.txt');
    assert.deepEqual(one.stats, { added: 2, removed: 1 });
    assert.equal(one.hunks[0].newStart, 1);
    assert.equal(body.local.files.find((f) => f.rel === 'gone.txt').kind, 'deleted');
    assert.equal(body.local.files.find((f) => f.rel === 'lib/two.js').kind, 'created');
    assert.deepEqual(
      body.chapters[1].files.map((f) => f.rel),
      ['lib/two.js'],
    );
    assert.equal(body.chapters[2].title, 'Chapter 3: Not in a chapter yet');
  });

  test('serves its page with the token and a strict CSP, and not for GitHub stories', async () => {
    const page = await b.call('GET', `/local/${id}/`);
    assert.equal(page.status, 200);
    assert.match(page.text, /id="ds-boot"/);
    assert.ok(page.text.includes(TOKEN));
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await b.call('GET', '/assets/overlay.js')).status, 200);
    assert.equal((await b.call('GET', '/assets/local.js')).status, 200);
  });

  test('keeps viewed files, and forgets one when its diff changes', async () => {
    assert.equal(
      (await b.call('POST', `/api/stories/${id}/viewed`, { path: 'one.txt', viewed: true })).status,
      200,
    );
    assert.equal(
      (await b.call('POST', `/api/stories/${id}/viewed`, { path: 'lib/two.js', viewed: true }))
        .status,
      200,
    );
    assert.equal(
      (await b.call('POST', `/api/stories/${id}/viewed`, { path: 'nope.txt', viewed: true }))
        .status,
      404,
    );
    let files = (await b.call('GET', `/api/stories/${id}`)).body.local.files;
    assert.equal(files.find((f) => f.rel === 'one.txt').viewed, true);

    const before = (await b.call('GET', `/api/stories/${id}/version`)).body.version;
    writeFileSync(path.join(repo, 'one.txt'), 'a\nB\nc\nd\ne\n');
    git(repo, 'commit', '-q', '-am', 'amend one');
    await new Promise((r) => setTimeout(r, 20));
    const after = (await b.call('GET', `/api/stories/${id}/version`)).body.version;
    assert.notEqual(before, after, 'a new commit changes the version');
    files = (await b.call('GET', `/api/stories/${id}`)).body.local.files;
    assert.equal(files.find((f) => f.rel === 'one.txt').viewed, false);
    assert.equal(files.find((f) => f.rel === 'one.txt').viewed_changed, true);
    assert.equal(files.find((f) => f.rel === 'lib/two.js').viewed, true);
  });

  test('fix-before-push notes: add, finish, delete, and each goes to the inbox', async () => {
    const n = await b.call('POST', `/api/stories/${id}/notes`, {
      path: 'one.txt',
      side: 'R',
      line: 2,
      body: 'Lower-case this',
    });
    assert.equal(n.status, 200);
    assert.equal(n.body.done, false);
    const done = await b.call('POST', `/api/stories/${id}/notes/${n.body.id}`, { done: true });
    assert.equal(done.body.done, true);
    let notes = (await b.call('GET', `/api/stories/${id}`)).body.local.notes;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].done, true);
    await b.call('POST', `/api/stories/${id}/notes/${n.body.id}`, { delete: true });
    notes = (await b.call('GET', `/api/stories/${id}`)).body.local.notes;
    assert.equal(notes.length, 0);
    const logged = readFileSync(path.join(home, 'inbox.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
      .filter((e) => e.type === 'note');
    assert.deepEqual(
      logged.map((e) => e.action),
      ['added', 'updated', 'deleted'],
    );
  });
});

describe('drafted comments', () => {
  test('a comment lands in the chapter, in the served copy and its pr-story source, once', async () => {
    const home = tmp('home');
    const src = tmp('scratch');
    githubStory(src);
    githubStory(path.join(home, 'acme-widgets-7'));
    writeJson(path.join(home, 'acme-widgets-7', 'meta.json'), {
      kind: 'github',
      repo: 'acme/widgets',
      number: 7,
      source: src,
    });
    const b = await startBridge({ home });
    try {
      const v1 = (await b.call('GET', '/api/stories/acme-widgets-7/version')).body.version;
      await new Promise((r) => setTimeout(r, 20));
      const c = {
        chapter: 2,
        path: 'src/b.js',
        line: 4,
        body: 'Could you confirm this handles an empty list?',
      };
      const r = await b.call('POST', '/api/stories/acme-widgets-7/comments', c);
      assert.equal(r.status, 200);
      assert.equal(r.body.added, true);
      assert.equal(r.body.files.length, 2);
      const again = await b.call('POST', '/api/stories/acme-widgets-7/comments', c);
      assert.equal(again.body.added, false, 'the same comment twice is kept once');
      const data = (await b.call('GET', '/api/stories/acme-widgets-7')).body;
      assert.deepEqual(data.chapters[1].comments, [{ path: 'src/b.js', line: 4, body: c.body }]);
      const fromSrc = JSON.parse(readFileSync(path.join(src, 'chapters.json'), 'utf8'));
      assert.equal(
        fromSrc.chapters[1].comments.length,
        1,
        'the pr-story source gets it too, so the next render keeps it',
      );
      assert.notEqual(
        (await b.call('GET', '/api/stories/acme-widgets-7/version')).body.version,
        v1,
        'the panel sees a new version',
      );
      assert.equal(
        (await b.call('POST', '/api/stories/acme-widgets-7/comments', { chapter: 9, body: 'x' }))
          .status,
        400,
      );
      assert.equal(
        (await b.call('POST', '/api/stories/acme-widgets-7/comments', { chapter: 1, body: ' ' }))
          .status,
        400,
      );
    } finally {
      await b.close();
    }
  });
});

describe('Hide whitespace on local stories', () => {
  let home, repo, base, id, b;
  const file = (body, rel) => body.local.files.find((f) => f.rel === rel);
  before(async () => {
    home = tmp('home');
    repo = tmp('repo');
    git(repo, 'init', '-q', '-b', 'ws');
    writeFileSync(path.join(repo, 'indent.js'), 'if (x) {\ny();\n}\n');
    writeFileSync(path.join(repo, 'mixed.js'), 'const a = 1;\nconst b = 2;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    base = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(path.join(repo, 'indent.js'), 'if (x) {\n  y();\n}\n'); // whitespace only
    writeFileSync(path.join(repo, 'mixed.js'), 'const a  =  1;\nconst b = 3;\n'); // one whitespace line, one real change
    git(repo, 'commit', '-q', '-am', 'reindent and change b');
    id = createLocalStory({ home, repo, base, head: 'HEAD' }).id;
    b = await startBridge({ home });
  });
  after(() => b.close());

  test('is off by default, and the setting is saved in prefs.json, not per story', async () => {
    assert.deepEqual((await b.call('GET', '/api/prefs')).body, {
      hideWhitespace: false,
      diffView: 'unified',
    });
    const before = (await b.call('GET', `/api/stories/${id}`)).body;
    assert.equal(before.local.hide_whitespace, false);
    assert.deepEqual(file(before, 'mixed.js').stats, { added: 2, removed: 2 });
    assert.equal(file(before, 'indent.js').hunks.length, 1);

    assert.deepEqual((await b.call('POST', '/api/prefs', { hideWhitespace: true, junk: 1 })).body, {
      hideWhitespace: true,
      diffView: 'unified',
    });
    assert.deepEqual(JSON.parse(readFileSync(path.join(home, 'prefs.json'), 'utf8')), {
      hideWhitespace: true,
      diffView: 'unified',
    });
    await b.call('POST', '/api/prefs', { hideWhitespace: false });
  });

  test('draws the -w diff but keeps every file, its hash and its viewed mark', async () => {
    assert.equal(
      (await b.call('POST', `/api/stories/${id}/viewed`, { path: 'indent.js', viewed: true }))
        .status,
      200,
    );
    assert.equal(
      (await b.call('POST', `/api/stories/${id}/viewed`, { path: 'mixed.js', viewed: true }))
        .status,
      200,
    );
    const full = (await b.call('GET', `/api/stories/${id}`)).body;
    const v1 = (await b.call('GET', `/api/stories/${id}/version`)).body.version;

    await b.call('POST', '/api/prefs', { hideWhitespace: true });
    const v2 = (await b.call('GET', `/api/stories/${id}/version`)).body.version;
    assert.notEqual(v1, v2, 'a page polling the version redraws when the setting changes');
    const hid = (await b.call('GET', `/api/stories/${id}`)).body;
    assert.equal(hid.local.hide_whitespace, true);
    assert.equal(hid.version, v2);
    assert.deepEqual(
      hid.local.files.map((f) => f.rel),
      full.local.files.map((f) => f.rel),
      'a whitespace-only file stays listed',
    );
    const indent = file(hid, 'indent.js');
    assert.equal(indent.whitespace_only, true);
    assert.deepEqual(indent.hunks, []);
    assert.deepEqual(indent.stats, { added: 0, removed: 0 });
    assert.deepEqual(file(hid, 'mixed.js').stats, { added: 1, removed: 1 });
    assert.equal(file(hid, 'mixed.js').whitespace_only, false);
    for (const f of hid.local.files) {
      assert.equal(f.hash, file(full, f.rel).hash, `${f.rel} keeps the full diff's hash`);
      assert.equal(f.viewed, true, `${f.rel} stays viewed`);
      assert.equal(f.viewed_changed, false, `${f.rel} isn't "changed since viewed"`);
    }

    await b.call('POST', '/api/prefs', { hideWhitespace: false });
    const back = (await b.call('GET', `/api/stories/${id}`)).body;
    assert.equal(back.version, v1);
    assert.ok(back.local.files.every((f) => f.viewed));
  });

  test('outlives a bridge restart and holds for other stories', async () => {
    await b.call('POST', '/api/prefs', { hideWhitespace: true });
    const other = createLocalStory({ home, repo, base, head: 'HEAD', id: 'local-other' }).id;
    const b2 = await startBridge({ home });
    try {
      assert.deepEqual((await b2.call('GET', '/api/prefs')).body, {
        hideWhitespace: true,
        diffView: 'unified',
      });
      assert.equal(
        (await b2.call('GET', `/api/stories/${other}`)).body.local.hide_whitespace,
        true,
      );
    } finally {
      await b2.close();
      await b.call('POST', '/api/prefs', { hideWhitespace: false });
    }
  });

  test('remakes the -w diff when the branch moves', async () => {
    await b.call('POST', '/api/prefs', { hideWhitespace: true });
    assert.equal(
      file((await b.call('GET', `/api/stories/${id}`)).body, 'indent.js').whitespace_only,
      true,
    );
    writeFileSync(path.join(repo, 'indent.js'), 'if (x) {\n  y();\n  z();\n}\n');
    git(repo, 'commit', '-q', '-am', 'call z');
    await new Promise((r) => setTimeout(r, 20));
    const indent = file((await b.call('GET', `/api/stories/${id}`)).body, 'indent.js');
    assert.equal(indent.whitespace_only, false);
    assert.deepEqual(indent.stats, { added: 1, removed: 0 });
    assert.equal(indent.viewed_changed, true, 'a real change after viewing still shows');
    await b.call('POST', '/api/prefs', { hideWhitespace: false });
  });
});

describe('Unified / Split on local stories', () => {
  test('the view is saved in prefs.json beside Hide whitespace, and changes only how the diff is drawn', async () => {
    const home = tmp('home');
    const { repo, base } = localRepo();
    const { id } = createLocalStory({ home, repo, base, head: 'HEAD' });
    const b = await startBridge({ home });
    try {
      let data = (await b.call('GET', `/api/stories/${id}`)).body;
      assert.equal(data.local.diff_view, 'unified');
      await b.call('POST', `/api/stories/${id}/viewed`, { path: 'one.txt', viewed: true });
      const v1 = (await b.call('GET', `/api/stories/${id}/version`)).body.version;

      assert.deepEqual((await b.call('POST', '/api/prefs', { diffView: 'split' })).body, {
        hideWhitespace: false,
        diffView: 'split',
      });
      assert.deepEqual(
        (await b.call('POST', '/api/prefs', { hideWhitespace: true })).body,
        { hideWhitespace: true, diffView: 'split' },
        'one setting leaves the other alone',
      );
      assert.deepEqual(JSON.parse(readFileSync(path.join(home, 'prefs.json'), 'utf8')), {
        hideWhitespace: true,
        diffView: 'split',
      });
      const v2 = (await b.call('GET', `/api/stories/${id}/version`)).body.version;
      assert.notEqual(v1, v2, 'other tabs redraw');
      const split = (await b.call('GET', `/api/stories/${id}`)).body;
      assert.equal(split.local.diff_view, 'split');
      assert.equal(split.local.hide_whitespace, true);
      assert.equal(
        split.local.files.find((f) => f.rel === 'one.txt').viewed,
        true,
        'viewed holds across the view change',
      );
      assert.deepEqual(
        split.local.files.map((f) => f.hash),
        data.local.files.map((f) => f.hash),
      );

      assert.equal(
        (await b.call('POST', '/api/prefs', { diffView: 'sideways' })).body.diffView,
        'unified',
        'anything else is unified',
      );
      const b2 = await startBridge({ home });
      try {
        await b2.call('POST', '/api/prefs', { diffView: 'split' });
        data = (await b2.call('GET', `/api/stories/${id}`)).body;
        assert.equal(data.local.diff_view, 'split', 'survives a restart');
      } finally {
        await b2.close();
      }
      assert.equal((await b.call('GET', '/assets/split.js')).status, 200);
      assert.equal((await b.call('GET', '/assets/narrow.js')).status, 200);
    } finally {
      await b.close();
    }
  });
});
