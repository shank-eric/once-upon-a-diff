/*
 * Stories: list what the bridge can serve, make a local story over commits
 * (local), and publish a pr-story folder where the bridge finds it.
 */
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openArgv } from '../../config/settings.mjs';
import { StoryStore } from '../../stories/store.mjs';
import { readMeta } from '../../stories/meta.mjs';
import { createLocalStory, slug } from '../../stories/local-story.mjs';
import { storyDirFor } from '../../stories/placement.mjs';
import { out } from '../output.mjs';
import { probe, serve } from './bridge.mjs';

function list(home, cfg, opts) {
  const store = new StoryStore({
    home,
    roots: opts.root.length ? opts.root : cfg.roots,
    scratch: !opts['no-scratch'],
  });
  for (const story of store.list()) {
    out(
      `${story.id}\t${story.kind}\t${story.repo ? `${story.repo}#${story.number}` : ''}\t${story.title}\t${story.dir}`,
    );
  }
}

async function local(home, cfg, opts) {
  if (!opts.repo || !opts.base) {
    throw new Error('usage: diff-story local --repo DIR --base REF [--head REF] [--chapters FILE]');
  }
  const made = createLocalStory({
    home,
    repo: path.resolve(opts.repo),
    base: opts.base,
    head: opts.head || 'HEAD',
    chapters: opts.chapters,
    id: opts.id,
    title: opts.title,
  });
  process.stderr.write(
    `Story ${made.id}: ${made.files} files, ${made.chapters} chapters (${made.dir})\n`,
  );
  if (made.unplaced.length) {
    process.stderr.write(
      `  ${made.unplaced.length} files aren't in a chapter; they show in a last "Not in a chapter yet" step\n`,
    );
  }
  if (made.unknown.length) {
    process.stderr.write(
      `  ${made.unknown.length} chapter files aren't in the diff and are skipped: ${made.unknown.join(', ')}\n`,
    );
  }
  const port = Number(opts.port || cfg.port);
  const url = `http://127.0.0.1:${port}/local/${encodeURIComponent(made.id)}/`;
  const running = await probe(port, cfg.token);
  if (!running && !opts['no-serve']) {
    await serve(home, cfg, { ...opts, port });
  } else if (!running) {
    process.stderr.write(`No bridge on port ${port}. Start one with: diff-story serve\n`);
  }
  out(url);
  if (!opts['no-open']) {
    const [cmd, ...args] = openArgv(url, home);
    execFile(cmd, args, () => {});
  }
}

function publish(home, cfg, opts) {
  if (!opts.dir) {
    throw new Error('usage: diff-story publish --dir <pr-story folder>');
  }
  const source = path.resolve(opts.dir);
  const meta = readMeta(source);
  if (!meta.repo || !meta.number) {
    throw new Error(`${source} doesn't say which PR it is (no pr.json or file-map.json)`);
  }
  const id = opts.id || slug(`${meta.repo.replace('/', '-')}-${meta.number}`);
  // into the repo's checkout (.diff-story/<id>, kept out of git) when the bridge knows it, else ~/.diff-story/<id>
  const dest = storyDirFor(home, id, { repo: meta.repo });
  for (const name of ['chapters.json', 'file-map.json']) {
    if (existsSync(path.join(source, name))) {
      copyFileSync(path.join(source, name), path.join(dest, name));
    }
  }
  writeFileSync(
    path.join(dest, 'meta.json'),
    JSON.stringify(
      {
        kind: 'github',
        repo: meta.repo,
        number: meta.number,
        url: meta.url,
        pr_title: meta.pr_title || null,
        source,
        published_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  out(dest);
}

export const storyCommands = [
  {
    name: 'list',
    usage: [
      '  diff-story list                                                stories the bridge can serve',
    ],
    run: list,
  },
  {
    name: 'local',
    usage: [
      '  diff-story local   --repo DIR --base REF [--head REF] [--chapters FILE] [--id ID] [--title T] [--no-open]',
      '                                                                 story over local commits, served at /local/<id>/',
    ],
    run: local,
  },
  {
    name: 'publish',
    usage: [
      '  diff-story publish --dir DIR [--id ID]                         copy a pr-story folder into <checkout>/.diff-story/<owner>-<repo>-<N>/ (or ~/.diff-story/)',
    ],
    run: publish,
  },
];
