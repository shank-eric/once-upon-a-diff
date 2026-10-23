import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../src/server/index.ts';

const BIN = fileURLToPath(new URL('../bin/once-upon.ts', import.meta.url));

export const tmp = (name) => mkdtempSync(path.join(os.tmpdir(), `once-upon-${name}-`));
// tests never look in (or move stories into) the real ~/Development checkouts
process.env.ONCE_UPON_DEV_DIR = mkdtempSync(path.join(os.tmpdir(), 'once-upon-dev-'));
export const TOKEN = 'test-token-0123456789abcdef';

export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

/**
 * A published story for acme/widgets#7 with two chapters (its pr.json too, so it also serves as a once-upon folder).
 * `meta` adds to or overrides its meta.json, such as the head_oid it was told from or its once-upon `source`.
 */
export function githubStory(dir, { meta = {} } = {}) {
  writeJson(path.join(dir, 'meta.json'), {
    kind: 'github',
    repo: 'acme/widgets',
    number: 7,
    url: 'https://github.com/acme/widgets/pull/7',
    pr_title: 'Add widgets',
    ...meta,
  });
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
  const server = createBridge({ token: TOKEN, ...opts });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
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

/** Runs the once-upon CLI against `home`: {code, stdout, stderr}. */
export const runCli = (home, args) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { env: { ...process.env, ONCE_UPON_HOME: home } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });
