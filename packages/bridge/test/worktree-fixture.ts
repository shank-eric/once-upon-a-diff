import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, git } from './helpers.ts';

/** A repo `widgets` (origin acme/widgets) with a base commit of a six-line a.txt, and a way to add worktrees to it. */
export function fixture(name = 'widgets', remote = 'git@github.com:acme/widgets.git') {
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
