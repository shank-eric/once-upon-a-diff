/*
 * Stories: list what the bridge can serve, make a local story over commits
 * (local), and publish a once-upon folder where the bridge finds it.
 */
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openArgv } from '../../config/settings.mjs';
import { StoryStore } from '../../stories/store.mjs';
import { Builds } from '../../inbox/builds.mjs';
import { readJson } from '../../util/json-file.mjs';
import { createLocalStory, slug } from '../../stories/local-story.mjs';
import { storyDirFor } from '../../stories/placement.mjs';
import { out } from '../output.mjs';
import { probe, serve } from './bridge.mjs';

function list(home) {
  const store = new StoryStore({ home });
  for (const story of store.list()) {
    out(
      `${story.id}\t${story.kind}\t${story.repo ? `${story.repo}#${story.number}` : ''}\t${story.title}\t${story.dir}`,
    );
  }
}

async function local(home, cfg, opts) {
  if (!opts.repo || !opts.base) {
    throw new Error('usage: once-upon local --repo DIR --base REF [--head REF] [--chapters FILE]');
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
    process.stderr.write(`No bridge on port ${port}. Start one with: once-upon serve\n`);
  }
  out(url);
  if (!opts['no-open']) {
    const [cmd, ...args] = openArgv(url, home);
    execFile(cmd, args, () => {});
  }
}

function publish(home, cfg, opts) {
  if (!opts.dir) {
    throw new Error('usage: once-upon publish --dir <once-upon folder>');
  }
  const source = path.resolve(opts.dir);
  const pr = readJson(path.join(source, 'pr.json'), null);
  const repo = pr && pr.url ? pr.url.split('/').slice(3, 5).join('/') : null;
  if (!repo || !pr.number) {
    throw new Error(`${source} doesn't say which PR it is (no pr.json naming it)`);
  }
  const id = opts.id || slug(`${repo.replace('/', '-')}-${pr.number}`);
  // into the repo's checkout (.once-upon/<id>, kept out of git) when the bridge knows it, else ~/.once-upon/<id>
  const dest = storyDirFor(home, id, { repo });
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
        repo,
        number: pr.number,
        url: pr.url,
        pr_title: pr.title || null,
        head_oid: pr.headRefOid || null, // the commit the story was told from
        base_oid: pr.baseRefOid || null,
        source,
        published_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  // the story is here, so a Build story or Update request for the PR is done
  new Builds(home).settle(repo, pr.number, { story: id, head: pr.headRefOid || null });
  out(dest);
}

export const storyCommands = [
  {
    name: 'list',
    usage: [
      '  once-upon list                                                stories the bridge can serve',
    ],
    run: list,
  },
  {
    name: 'local',
    usage: [
      '  once-upon local   --repo DIR --base REF [--head REF] [--chapters FILE] [--id ID] [--title T] [--no-open]',
      '                                                                 story over local commits, served at /local/<id>/',
    ],
    run: local,
  },
  {
    name: 'publish',
    usage: [
      '  once-upon publish --dir DIR [--id ID]                         copy a once-upon folder into <checkout>/.once-upon/<owner>-<repo>-<N>/ (or ~/.once-upon/)',
      "                                                                 and finish the PR's build request",
    ],
    run: publish,
  },
];
