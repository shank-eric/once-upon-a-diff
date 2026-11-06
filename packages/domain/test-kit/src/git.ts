import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmp } from './files.ts';

export const git = (repo: string, ...args: string[]): string =>
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
export function localRepo(): { repo: string; base: string } {
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

/** A repo `widgets` (origin acme/widgets) with a base commit of a six-line a.txt, and a way to add worktrees to it. */
export function worktreeFixture(name = 'widgets', remote = 'git@github.com:acme/widgets.git') {
  // git reports real paths (/private/var on a Mac), so the fixture names them the same way
  const base = realpathSync(tmp('wt'));
  const main = path.join(base, name);
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'remote', 'add', 'origin', remote);
  writeFileSync(path.join(main, 'a.txt'), '1\n2\n3\n4\n5\n6\n');
  writeFileSync(path.join(main, '.gitignore'), '.env\nnode_modules/\ndist/\n*.local.json\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'base');
  const trees = path.join(base, `${name}-worktrees`);
  mkdirSync(trees);
  const add = (branch: string, folder = branch.replace(/\//g, '-')) => {
    const dir = path.join(trees, folder);
    git(main, 'worktree', 'add', '-q', dir, '-b', branch);
    return dir;
  };
  /** commits a change to a.txt line `line` in `dir` */
  const commit = (dir: string, subject: string, line = 1, text = 'changed') => {
    const file = path.join(dir, 'a.txt');
    const lines = (git(dir, 'show', 'HEAD:a.txt') + '\n').split('\n');
    lines[line - 1] = `${text}-${subject}`;
    writeFileSync(file, lines.join('\n'));
    git(dir, 'commit', '-q', '-am', subject);
  };
  return { base, main, trees, add, commit };
}
