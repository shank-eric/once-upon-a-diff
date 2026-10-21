import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../bridge/server/index.mjs';

export const tmp = (name) => mkdtempSync(path.join(os.tmpdir(), `diff-story-${name}-`));
// tests never look in (or move stories into) the real ~/Development checkouts
process.env.DIFF_STORY_DEV_DIR = mkdtempSync(path.join(os.tmpdir(), 'diff-story-dev-'));
export const TOKEN = 'test-token-0123456789abcdef';

export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

/** A pr-story folder for acme/widgets#7 with two chapters. */
export function githubStory(dir) {
  writeJson(path.join(dir, 'pr.json'), {
    url: 'https://github.com/acme/widgets/pull/7',
    number: 7,
    title: 'Add widgets',
  });
  writeJson(path.join(dir, 'file-map.json'), {
    pr: 'acme/widgets#7',
    files: {
      'src/a.js': { chapters: [1, 2], partial_in: [1], finished_in: 2 },
      'src/b.js': { chapters: [2], partial_in: [], finished_in: 2 },
      'README.md': { chapters: [], partial_in: [], finished_in: null },
    },
  });
  writeJson(path.join(dir, 'chapters.json'), {
    title: 'Widgets',
    overview: 'Story map',
    chapters: [
      {
        title: 'Chapter 1: Start',
        files: [
          {
            rel: 'src/a.js',
            partial: true,
            note: 'the top',
            lines: [{ side: 'R', start: 1, end: 3, label: 'top' }],
          },
        ],
        comments: [{ path: 'src/a.js', line: 2, body: 'Could you confirm?' }],
      },
      { title: 'Chapter 2: Finish', files: ['src/a.js', 'src/b.js'] },
    ],
  });
}

export const git = (repo, ...args) =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  }).trim();

/** A git repo with a base commit and two commits on top. Returns {repo, base}. */
export function localRepo() {
  const repo = tmp('repo');
  git(repo, 'init', '-q', '-b', 'feature');
  writeFileSync(path.join(repo, 'one.txt'), 'a\nb\nc\n');
  writeFileSync(path.join(repo, 'gone.txt'), 'bye\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(path.join(repo, 'one.txt'), 'a\nB\nc\nd\n');
  git(repo, 'commit', '-q', '-am', 'change one');
  mkdirSync(path.join(repo, 'lib'));
  writeFileSync(path.join(repo, 'lib/two.js'), 'export const two = 2;\n');
  git(repo, 'rm', '-q', 'gone.txt');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'add two');
  return { repo, base };
}

export async function startBridge(opts) {
  const server = createBridge({ token: TOKEN, scratch: false, ...opts });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  return { server, base, call, close: () => new Promise((resolve) => server.close(resolve)) };
}
