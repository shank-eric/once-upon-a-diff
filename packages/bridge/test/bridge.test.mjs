import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  tmp,
  githubStory,
  startBridge,
  TOKEN,
  localRepo,
  git,
  writeJson,
  runCli,
} from './helpers.mjs';
import { pathSha } from '../src/util/diff.mjs';
import { createLocalStory } from '../src/stories/local-story.mjs';
import { StoryStore } from '../src/stories/store.mjs';
import { beat } from '../src/listeners/listeners.mjs';

/** A raw request, for headers fetch won't let us set (Host). */
function raw(base, path, headers) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: url.port, path: path, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('bridge guard rails', () => {
  let bridge;
  before(async () => {
    const home = tmp('home');
    githubStory(path.join(home, 'acme-widgets-7'));
    bridge = await startBridge({ home });
  });
  after(() => bridge.close());

  test('binds to 127.0.0.1', () => {
    assert.equal(bridge.server.address().address, '127.0.0.1');
  });
  test('needs the token for /api', async () => {
    assert.equal(
      (await bridge.call('GET', '/api/stories', undefined, { Authorization: '' })).status,
      401,
    );
    assert.equal(
      (await bridge.call('GET', '/api/stories', undefined, { Authorization: 'Bearer nope' }))
        .status,
      401,
    );
    assert.equal((await bridge.call('GET', '/api/stories')).status, 200);
  });
  test('refuses a foreign Host header (DNS rebinding)', async () => {
    const response = await raw(bridge.base, '/api/health', {
      Host: 'evil.example:80',
      Authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(response.status, 421);
  });
  test('refuses web page origins but takes the extension and its own pages', async () => {
    assert.equal(
      (await bridge.call('GET', '/api/health', undefined, { Origin: 'https://github.com' })).status,
      403,
    );
    assert.equal(
      (
        await bridge.call('GET', '/api/health', undefined, {
          Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
        })
      ).status,
      200,
    );
    assert.equal(
      (await bridge.call('GET', '/api/health', undefined, { Origin: bridge.base })).status,
      200,
    );
  });
  test('writes must be JSON', async () => {
    const res = await fetch(`${bridge.base}/api/stories/acme-widgets-7/questions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/plain' },
      body: '{"text":"hi"}',
    });
    assert.equal(res.status, 415);
  });
  test('sends no CORS headers', async () => {
    const response = await bridge.call('GET', '/api/stories');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });
  test('rejects story ids that try to leave the root', async () => {
    assert.equal((await bridge.call('GET', '/api/stories/..%2F..%2Fetc')).status, 404);
    assert.equal((await bridge.call('GET', '/api/stories/.hidden')).status, 404);
  });
});

describe('GitHub stories', () => {
  let bridge, home;
  before(async () => {
    home = tmp('home');
    githubStory(path.join(home, 'acme-widgets-7'));
    bridge = await startBridge({ home });
  });
  after(() => bridge.close());

  test('lists stories, and the store finds one by repo and number, case-insensitively', async () => {
    const list = await bridge.call('GET', '/api/stories');
    assert.deepEqual(
      list.body.stories.map((story) => story.id),
      ['acme-widgets-7'],
    );
    const store = new StoryStore({ home });
    assert.equal(store.find('ACME/Widgets', 7).id, 'acme-widgets-7');
    assert.equal(store.find('acme/widgets', 8), null);
  });

  test('serves the panel data with GitHub anchors and an extra chapter for unplaced files', async () => {
    const { body } = await bridge.call('GET', '/api/stories/acme-widgets-7');
    assert.equal(body.kind, 'github');
    assert.equal(body.pr.url, 'https://github.com/acme/widgets/pull/7');
    assert.deepEqual(body.files.map((file) => file.rel).sort(), [
      'README.md',
      'src/a.js',
      'src/b.js',
    ]);
    assert.equal(body.files.find((file) => file.rel === 'src/a.js').sha, pathSha('src/a.js'));
    assert.equal(body.chapters.length, 3);
    assert.deepEqual(body.chapters[0].files[0], {
      rel: 'src/a.js',
      partial: true,
      note: 'the top',
      lines: [{ side: 'R', start: 1, end: 3, label: 'top' }],
    });
    assert.equal(body.chapters[2].title, 'Chapter 3: Not in a chapter yet');
    assert.deepEqual(
      body.chapters[2].files.map((file) => file.rel),
      ['README.md'],
    );
    assert.equal(body.local, undefined);
  });

  test('version changes when chapters.json does', async () => {
    const before = (await bridge.call('GET', '/api/stories/acme-widgets-7/version')).body.version;
    const file = path.join(home, 'acme-widgets-7', 'chapters.json');
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(file, readFileSync(file, 'utf8').replace('Story map', 'Story map, updated'));
    const after = (await bridge.call('GET', '/api/stories/acme-widgets-7/version')).body.version;
    assert.notEqual(before, after);
  });

  test('questions go to the inbox and come back with their answers', async () => {
    const question = await bridge.call('POST', '/api/stories/acme-widgets-7/questions', {
      text: '  Why is a.js split?  ',
      step: 1,
      chapter: 'Chapter 1: Start',
      file: 'src/a.js',
      url: 'https://github.com/acme/widgets/pull/7/changes',
    });
    assert.equal(question.status, 200);
    assert.match(question.body.id, /^q_/);
    assert.equal(question.body.text, 'Why is a.js split?');
    const lines = readFileSync(path.join(home, 'inbox.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    const logged = lines.find((e) => e.id === question.body.id);
    assert.equal(logged.type, 'question');
    assert.equal(logged.story, 'acme-widgets-7');
    assert.equal(logged.step, 1);
    assert.equal(
      (await bridge.call('POST', '/api/stories/acme-widgets-7/questions', { text: ' ' })).status,
      400,
    );

    const answer = await runCli(home, [
      'answer',
      '--question',
      question.body.id,
      '--text',
      'Because **chapter 2** finishes it.',
    ]);
    assert.equal(answer.code, 0, answer.stderr);
    const { body } = await bridge.call('GET', '/api/stories/acme-widgets-7/questions');
    const back = body.questions.find((entry) => entry.id === question.body.id);
    assert.equal(back.answers.length, 1);
    assert.equal(back.answers[0].text, 'Because **chapter 2** finishes it.');
  });

  test('positions are kept in position.json, not the inbox', async () => {
    const pos = { step: 2, chapter: 'Chapter 2: Finish', file: 'src/b.js' };
    assert.equal(
      (await bridge.call('POST', '/api/stories/acme-widgets-7/position', pos)).status,
      200,
    );
    await bridge.call('POST', '/api/stories/acme-widgets-7/position', { ...pos, file: 'src/a.js' });
    const saved = JSON.parse(
      readFileSync(path.join(home, 'state', 'acme-widgets-7', 'position.json'), 'utf8'),
    );
    assert.equal(saved.file, 'src/a.js');
    assert.equal(saved.step, 2);
    const inbox = existsSync(path.join(home, 'inbox.jsonl'))
      ? readFileSync(path.join(home, 'inbox.jsonl'), 'utf8')
      : '';
    assert.ok(!inbox.includes('"position"'));
  });

  test('keeps the panel state per story', async () => {
    await bridge.call('POST', '/api/stories/acme-widgets-7/ui', {
      n: 2,
      collapsed: true,
      width: 500,
    });
    const { body } = await bridge.call('GET', '/api/stories/acme-widgets-7/ui');
    assert.equal(body.n, 2);
    assert.equal(body.collapsed, true);
    assert.equal(body.width, 500);
  });

  test('viewed is only for local stories; fix-before-push notes are for PR stories too', async () => {
    assert.equal(
      (
        await bridge.call('POST', '/api/stories/acme-widgets-7/viewed', {
          path: 'src/a.js',
          viewed: true,
        })
      ).status,
      400,
    );
    const note = await bridge.call('POST', '/api/stories/acme-widgets-7/notes', {
      path: 'src/a.js',
      line: 1,
      body: 'x',
    });
    assert.equal(note.status, 200);
    assert.equal(note.body.state, 'draft');
  });
});

describe('story discovery', () => {
  test('finds a story in the index or in home, and the indexed folder wins', () => {
    const home = tmp('home');
    const checkout = tmp('checkout');
    githubStory(path.join(home, 'acme-widgets-7'));
    githubStory(path.join(checkout, '.once-upon', 'acme-widgets-7'));
    githubStory(path.join(home, 'widgets-9'));
    writeJson(path.join(home, 'stories.json'), {
      'acme-widgets-7': path.join(checkout, '.once-upon', 'acme-widgets-7'),
    });
    const store = new StoryStore({ home });
    const list = store.list();
    assert.deepEqual(list.map((story) => story.id).sort(), ['acme-widgets-7', 'widgets-9']);
    assert.equal(
      list.find((story) => story.id === 'acme-widgets-7').dir,
      path.join(checkout, '.once-upon', 'acme-widgets-7'),
    );
    assert.ok(store.find('acme/widgets', 7));
  });
  test('a folder with chapters.json but no meta.json is not a story', () => {
    const home = tmp('home');
    writeJson(path.join(home, 'scratch-copy', 'chapters.json'), { chapters: [] });
    writeJson(path.join(home, 'scratch-copy', 'pr.json'), {
      url: 'https://github.com/a/b/pull/1',
      number: 1,
    });
    assert.deepEqual(new StoryStore({ home }).list(), []);
  });
  test('ignores folders without chapters.json', () => {
    const home = tmp('home');
    writeJson(path.join(home, 'state', 'x', 'ui.json'), {});
    writeJson(path.join(home, 'half', 'meta.json'), { kind: 'github' });
    assert.deepEqual(new StoryStore({ home }).list(), []);
  });
});

describe('local stories', () => {
  let bridge, home, repo, base, id;
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
    bridge = await startBridge({ home });
  });
  after(() => bridge.close());

  test('is named for the repo and branch', () => {
    assert.match(id, /^local-once-upon-repo-.+-feature$/);
  });

  test('serves the diff with hunks, and drops chapter files that are not in it', async () => {
    const { body } = await bridge.call('GET', `/api/stories/${id}`);
    assert.equal(body.kind, 'local');
    assert.equal(body.local.base_oid, base);
    assert.equal(body.local.commits.length, 2);
    const one = body.local.files.find((file) => file.rel === 'one.txt');
    assert.deepEqual(one.stats, { added: 2, removed: 1 });
    assert.equal(one.hunks[0].newStart, 1);
    assert.equal(body.local.files.find((file) => file.rel === 'gone.txt').kind, 'deleted');
    assert.equal(body.local.files.find((file) => file.rel === 'lib/two.js').kind, 'created');
    assert.deepEqual(
      body.chapters[1].files.map((file) => file.rel),
      ['lib/two.js'],
    );
    assert.equal(body.chapters[2].title, 'Chapter 3: Not in a chapter yet');
  });

  test('serves its page with the token and a strict CSP, and not for GitHub stories', async () => {
    const page = await bridge.call('GET', `/local/${id}/`);
    assert.equal(page.status, 200);
    assert.match(page.text, /id="ou-local-boot"/);
    assert.ok(page.text.includes(TOKEN));
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await bridge.call('GET', '/assets/overlay.js')).status, 200);
    assert.equal((await bridge.call('GET', '/assets/local.js')).status, 200);
    for (const sheet of ['panel.css', 'page.css']) {
      const css = await bridge.call('GET', `/assets/panel/${sheet}`);
      assert.equal(css.status, 200, sheet);
      assert.match(css.headers.get('content-type'), /^text\/css/);
    }
  });

  test('keeps viewed files, and forgets one when its diff changes', async () => {
    assert.equal(
      (await bridge.call('POST', `/api/stories/${id}/viewed`, { path: 'one.txt', viewed: true }))
        .status,
      200,
    );
    assert.equal(
      (await bridge.call('POST', `/api/stories/${id}/viewed`, { path: 'lib/two.js', viewed: true }))
        .status,
      200,
    );
    assert.equal(
      (await bridge.call('POST', `/api/stories/${id}/viewed`, { path: 'nope.txt', viewed: true }))
        .status,
      404,
    );
    let files = (await bridge.call('GET', `/api/stories/${id}`)).body.local.files;
    assert.equal(files.find((file) => file.rel === 'one.txt').viewed, true);

    const before = (await bridge.call('GET', `/api/stories/${id}/version`)).body.version;
    writeFileSync(path.join(repo, 'one.txt'), 'a\nB\nc\nd\ne\n');
    git(repo, 'commit', '-q', '-am', 'amend one');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = (await bridge.call('GET', `/api/stories/${id}/version`)).body.version;
    assert.notEqual(before, after, 'a new commit changes the version');
    files = (await bridge.call('GET', `/api/stories/${id}`)).body.local.files;
    assert.equal(files.find((file) => file.rel === 'one.txt').viewed, false);
    assert.equal(files.find((file) => file.rel === 'one.txt').viewed_changed, true);
    assert.equal(files.find((file) => file.rel === 'lib/two.js').viewed, true);
  });

  test('fix-before-push notes: add, finish, delete, and each goes to the inbox', async () => {
    const note = await bridge.call('POST', `/api/stories/${id}/notes`, {
      path: 'one.txt',
      side: 'R',
      line: 2,
      body: 'Lower-case this',
    });
    assert.equal(note.status, 200);
    assert.equal(note.body.done, false);
    const done = await bridge.call('POST', `/api/stories/${id}/notes/${note.body.id}`, {
      done: true,
    });
    assert.equal(done.body.done, true);
    let notes = (await bridge.call('GET', `/api/stories/${id}`)).body.local.notes;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].done, true);
    await bridge.call('POST', `/api/stories/${id}/notes/${note.body.id}`, { delete: true });
    notes = (await bridge.call('GET', `/api/stories/${id}`)).body.local.notes;
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

describe('pulse', () => {
  test('one call whose fields move when the story, its questions, its drafts or a listener do', async () => {
    const home = tmp('home');
    githubStory(path.join(home, 'acme-widgets-7'));
    const bridge = await startBridge({ home });
    const pulse = async () => (await bridge.call('GET', '/api/stories/acme-widgets-7/pulse')).body;
    try {
      const first = await pulse();
      assert.deepEqual(Object.keys(first).sort(), [
        'answering',
        'drafts_rev',
        'fixes_rev',
        'listening',
        'questions_rev',
        'rebuild',
        'version',
        'working_rev',
      ]);
      assert.equal(first.rebuild, null, 'no rebuild asked for');
      assert.equal(first.listening, false);
      assert.deepEqual(await pulse(), first, 'nothing changed, nothing moves');

      const asked = await bridge.call('POST', '/api/stories/acme-widgets-7/questions', {
        text: 'Why?',
        step: 1,
      });
      const afterQuestion = await pulse();
      assert.notEqual(afterQuestion.questions_rev, first.questions_rev);
      await runCli(home, ['answer', '--question', asked.body.id, '--text', 'Because.']);
      assert.notEqual((await pulse()).questions_rev, afterQuestion.questions_rev);

      await bridge.call('POST', '/api/stories/acme-widgets-7/drafts', {
        action: 'dismiss',
        chapter: 1,
        index: 0,
      });
      const afterDismiss = await pulse();
      assert.notEqual(afterDismiss.drafts_rev, first.drafts_rev);
      assert.equal(afterDismiss.version, first.version, 'a mark is not a new story version');

      beat(home, 'once-upon', 'waiting', { repo: 'acme/widgets' });
      assert.equal((await pulse()).listening, true);
      assert.equal((await pulse()).answering, 'once-upon');
      beat(home, 'api-10', 'waiting', { story: 'acme-widgets-7' });
      assert.equal((await pulse()).answering, 'api-10', "the story's own listener answers it");
    } finally {
      await bridge.close();
    }
  });
});

describe('drafted comments', () => {
  test('a comment lands in the chapter, in the served copy and its once-upon source, once', async () => {
    const home = tmp('home');
    const src = tmp('scratch');
    githubStory(src);
    githubStory(path.join(home, 'acme-widgets-7'), { meta: { source: src } });
    const bridge = await startBridge({ home });
    try {
      const before = (await bridge.call('GET', '/api/stories/acme-widgets-7/version')).body.version;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const comment = {
        chapter: 2,
        path: 'src/b.js',
        line: 4,
        body: 'Could you confirm this handles an empty list?',
      };
      const add = (args) => runCli(home, ['comment', '--story', 'acme-widgets-7', ...args]);
      const args = [
        '--chapter',
        '2',
        '--path',
        comment.path,
        '--line',
        '4',
        '--body',
        comment.body,
      ];
      const response = await add(args);
      assert.equal(response.code, 0, response.stderr);
      assert.match(response.stdout, /^Added to chapter 2's draft comments \(.+, .+\)/);
      const again = await add(args);
      assert.match(again.stdout, /^Already in/, 'the same comment twice is kept once');
      assert.equal(
        readFileSync(path.join(home, 'inbox.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map(JSON.parse)
          .filter((e) => e.type === 'comment').length,
        1,
      );
      const data = (await bridge.call('GET', '/api/stories/acme-widgets-7')).body;
      assert.deepEqual(data.chapters[1].comments, [
        { path: 'src/b.js', line: 4, body: comment.body },
      ]);
      const fromSrc = JSON.parse(readFileSync(path.join(src, 'chapters.json'), 'utf8'));
      assert.equal(
        fromSrc.chapters[1].comments.length,
        1,
        'the once-upon source gets it too, so the next render keeps it',
      );
      assert.notEqual(
        (await bridge.call('GET', '/api/stories/acme-widgets-7/version')).body.version,
        before,
        'the panel sees a new version',
      );
      assert.notEqual((await add(['--chapter', '9', '--body', 'x'])).code, 0);
      assert.notEqual((await add(['--chapter', '1', '--body', ' '])).code, 0);
    } finally {
      await bridge.close();
    }
  });
});

describe('Hide whitespace on local stories', () => {
  let home, repo, base, id, bridge;
  const file = (body, rel) => body.local.files.find((entry) => entry.rel === rel);
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
    bridge = await startBridge({ home });
  });
  after(() => bridge.close());

  test('is off by default, and the setting is saved in prefs.json, not per story', async () => {
    assert.deepEqual((await bridge.call('GET', '/api/prefs')).body, {
      hideWhitespace: false,
      diffView: 'unified',
    });
    const before = (await bridge.call('GET', `/api/stories/${id}`)).body;
    assert.equal(before.local.hide_whitespace, false);
    assert.deepEqual(file(before, 'mixed.js').stats, { added: 2, removed: 2 });
    assert.equal(file(before, 'indent.js').hunks.length, 1);

    assert.deepEqual(
      (await bridge.call('POST', '/api/prefs', { hideWhitespace: true, junk: 1 })).body,
      {
        hideWhitespace: true,
        diffView: 'unified',
      },
    );
    assert.deepEqual(JSON.parse(readFileSync(path.join(home, 'prefs.json'), 'utf8')), {
      hideWhitespace: true,
      diffView: 'unified',
    });
    await bridge.call('POST', '/api/prefs', { hideWhitespace: false });
  });

  test('draws the -w diff but keeps every file, its hash and its viewed mark', async () => {
    assert.equal(
      (await bridge.call('POST', `/api/stories/${id}/viewed`, { path: 'indent.js', viewed: true }))
        .status,
      200,
    );
    assert.equal(
      (await bridge.call('POST', `/api/stories/${id}/viewed`, { path: 'mixed.js', viewed: true }))
        .status,
      200,
    );
    const full = (await bridge.call('GET', `/api/stories/${id}`)).body;
    const before = (await bridge.call('GET', `/api/stories/${id}/version`)).body.version;

    await bridge.call('POST', '/api/prefs', { hideWhitespace: true });
    const after = (await bridge.call('GET', `/api/stories/${id}/version`)).body.version;
    assert.notEqual(before, after, 'a page polling the version redraws when the setting changes');
    const hid = (await bridge.call('GET', `/api/stories/${id}`)).body;
    assert.equal(hid.local.hide_whitespace, true);
    assert.equal(hid.version, after);
    assert.deepEqual(
      hid.local.files.map((entry) => entry.rel),
      full.local.files.map((entry) => entry.rel),
      'a whitespace-only file stays listed',
    );
    const indent = file(hid, 'indent.js');
    assert.equal(indent.whitespace_only, true);
    assert.deepEqual(indent.hunks, []);
    assert.deepEqual(indent.stats, { added: 0, removed: 0 });
    assert.deepEqual(file(hid, 'mixed.js').stats, { added: 1, removed: 1 });
    assert.equal(file(hid, 'mixed.js').whitespace_only, false);
    for (const entry of hid.local.files) {
      assert.equal(
        entry.hash,
        file(full, entry.rel).hash,
        `${entry.rel} keeps the full diff's hash`,
      );
      assert.equal(entry.viewed, true, `${entry.rel} stays viewed`);
      assert.equal(entry.viewed_changed, false, `${entry.rel} isn't "changed since viewed"`);
    }

    await bridge.call('POST', '/api/prefs', { hideWhitespace: false });
    const back = (await bridge.call('GET', `/api/stories/${id}`)).body;
    assert.equal(back.version, before);
    assert.ok(back.local.files.every((entry) => entry.viewed));
  });

  test('outlives a bridge restart and holds for other stories', async () => {
    await bridge.call('POST', '/api/prefs', { hideWhitespace: true });
    const other = createLocalStory({ home, repo, base, head: 'HEAD', id: 'local-other' }).id;
    const restarted = await startBridge({ home });
    try {
      assert.deepEqual((await restarted.call('GET', '/api/prefs')).body, {
        hideWhitespace: true,
        diffView: 'unified',
      });
      assert.equal(
        (await restarted.call('GET', `/api/stories/${other}`)).body.local.hide_whitespace,
        true,
      );
    } finally {
      await restarted.close();
      await bridge.call('POST', '/api/prefs', { hideWhitespace: false });
    }
  });

  test('remakes the -w diff when the branch moves', async () => {
    await bridge.call('POST', '/api/prefs', { hideWhitespace: true });
    assert.equal(
      file((await bridge.call('GET', `/api/stories/${id}`)).body, 'indent.js').whitespace_only,
      true,
    );
    writeFileSync(path.join(repo, 'indent.js'), 'if (x) {\n  y();\n  z();\n}\n');
    git(repo, 'commit', '-q', '-am', 'call z');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const indent = file((await bridge.call('GET', `/api/stories/${id}`)).body, 'indent.js');
    assert.equal(indent.whitespace_only, false);
    assert.deepEqual(indent.stats, { added: 1, removed: 0 });
    assert.equal(indent.viewed_changed, true, 'a real change after viewing still shows');
    await bridge.call('POST', '/api/prefs', { hideWhitespace: false });
  });
});

describe('Unified / Split on local stories', () => {
  test('the view is saved in prefs.json beside Hide whitespace, and changes only how the diff is drawn', async () => {
    const home = tmp('home');
    const { repo, base } = localRepo();
    const { id } = createLocalStory({ home, repo, base, head: 'HEAD' });
    const bridge = await startBridge({ home });
    try {
      let data = (await bridge.call('GET', `/api/stories/${id}`)).body;
      assert.equal(data.local.diff_view, 'unified');
      await bridge.call('POST', `/api/stories/${id}/viewed`, { path: 'one.txt', viewed: true });
      const before = (await bridge.call('GET', `/api/stories/${id}/version`)).body.version;

      assert.deepEqual((await bridge.call('POST', '/api/prefs', { diffView: 'split' })).body, {
        hideWhitespace: false,
        diffView: 'split',
      });
      assert.deepEqual(
        (await bridge.call('POST', '/api/prefs', { hideWhitespace: true })).body,
        { hideWhitespace: true, diffView: 'split' },
        'one setting leaves the other alone',
      );
      assert.deepEqual(JSON.parse(readFileSync(path.join(home, 'prefs.json'), 'utf8')), {
        hideWhitespace: true,
        diffView: 'split',
      });
      const after = (await bridge.call('GET', `/api/stories/${id}/version`)).body.version;
      assert.notEqual(before, after, 'other tabs redraw');
      const split = (await bridge.call('GET', `/api/stories/${id}`)).body;
      assert.equal(split.local.diff_view, 'split');
      assert.equal(split.local.hide_whitespace, true);
      assert.equal(
        split.local.files.find((entry) => entry.rel === 'one.txt').viewed,
        true,
        'viewed holds across the view change',
      );
      assert.deepEqual(
        split.local.files.map((entry) => entry.hash),
        data.local.files.map((entry) => entry.hash),
      );

      assert.equal(
        (await bridge.call('POST', '/api/prefs', { diffView: 'sideways' })).body.diffView,
        'unified',
        'anything else is unified',
      );
      const restarted = await startBridge({ home });
      try {
        await restarted.call('POST', '/api/prefs', { diffView: 'split' });
        data = (await restarted.call('GET', `/api/stories/${id}`)).body;
        assert.equal(data.local.diff_view, 'split', 'survives a restart');
      } finally {
        await restarted.close();
      }
      assert.equal((await bridge.call('GET', '/assets/split.js')).status, 200);
      assert.equal((await bridge.call('GET', '/assets/narrow.js')).status, 200);
    } finally {
      await bridge.close();
    }
  });
});
