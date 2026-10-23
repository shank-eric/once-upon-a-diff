/*
 * Stories: list what the bridge can serve, make a local story over commits
 * (local), and publish a once-upon folder where the bridge finds it.
 */
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openArgv } from '../../config/settings.ts';
import { StoryStore } from '../../stories/store.ts';
import { Builds } from '../../inbox/builds.ts';
import { readJson, writeJsonAtomic } from '../../util/json-file.ts';
import { parseUnifiedDiff } from '../../util/diff.ts';
import { stateKeyOf } from '../../github/drafts.ts';
import { vetRebuild, afterRebuild } from '../../stories/rebuild.ts';
import { createLocalStory, slug } from '../../stories/local-story.ts';
import { storyDirFor } from '../../stories/placement.ts';
import { out } from '../output.ts';
import { probe, serve } from './bridge.ts';
import type { Build } from '../../inbox/builds.ts';
import type { Plan } from '../../stories/chapters.ts';
import type { Config } from '../../config/settings.ts';
import type { CliOpts, Command, StoryMeta } from '../../types.ts';

/** A rebuild that's being published: its request, the chapters before and after, and the drafts carried over. */
type Rebuilt = {
  build: Build;
  before: Plan;
  after: Plan;
  counts: { carried: number; unmapped: number };
};

/** once-upon's pr.json: just what publish reads. */
interface PrJson {
  url?: string;
  number?: number;
  title?: string;
  headRefOid?: string;
  baseRefOid?: string;
  headRefName?: string;
}

function list(home: string) {
  const store = new StoryStore({ home });
  for (const story of store.list()) {
    out(
      `${story.id}\t${story.kind}\t${story.repo ? `${story.repo}#${story.number}` : ''}\t${story.title}\t${story.dir}`,
    );
  }
}

/** The story's pending rebuild request, or null. */
function pendingRebuild(builds: Builds, id: string, meta: StoryMeta): Build | null {
  const build = builds.rebuildOf(id, meta);
  return build && build.status === 'pending' ? build : null;
}

async function local(home: string, cfg: Config, opts: CliOpts) {
  if (!opts.repo || !opts.base) {
    throw new Error('usage: once-upon local --repo DIR --base REF [--head REF] [--chapters FILE]');
  }
  const builds = new Builds(home);
  let rebuilt = null as Rebuilt | null; // set by vet, when it publishes a rebuild
  const made = createLocalStory({
    home,
    repo: path.resolve(opts.repo as string),
    base: opts.base as string,
    head: (opts.head as string | undefined) || 'HEAD',
    chapters: opts.chapters as string | undefined,
    id: opts.id as string | undefined,
    title: opts.title as string | undefined,
    // the panel's Rebuild asked for these chapters: they must keep what it keeps and tell the whole diff
    vet: ({ id, meta, diff, before, after }) => {
      const build = pendingRebuild(builds, id, meta);
      if (!build) {
        return null;
      }
      const counts = vetRebuild(build, before, after, diff, {
        allowUncovered: !!opts['allow-uncovered'],
      });
      rebuilt = { build, before, after, counts };
      return after;
    },
  });
  if (rebuilt) {
    const note = afterRebuild(home, { id: made.id, stateKey: made.id, ...rebuilt });
    builds.settleStory(made.id, { note });
    process.stderr.write(`${note}\n`);
  }
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

function publish(home: string, cfg: Config, opts: CliOpts) {
  if (!opts.dir) {
    throw new Error('usage: once-upon publish --dir <once-upon folder>');
  }
  const source = path.resolve(opts.dir as string);
  const pr = readJson<PrJson>(path.join(source, 'pr.json'), null);
  const repo = pr && pr.url ? pr.url.split('/').slice(3, 5).join('/') : null;
  if (!repo || !pr!.number) {
    throw new Error(`${source} doesn't say which PR it is (no pr.json naming it)`);
  }
  const prJson = pr as PrJson & { number: number }; // named above
  const id = (opts.id as string | undefined) || slug(`${repo.replace('/', '-')}-${prJson.number}`);
  const builds = new Builds(home);
  const meta: StoryMeta = { kind: 'github', repo, number: prJson.number };
  const rebuild = pendingRebuild(builds, id, meta);
  // a rebuild the panel asked for: what was published before, checked against and carried into the new chapters
  let rebuilt: Rebuilt | null = null;
  if (rebuild) {
    const served = new StoryStore({ home }).dirOf(id);
    const before = (served && readJson<Plan>(path.join(served, 'chapters.json'), null)) || {};
    const after = readJson<Plan>(path.join(source, 'chapters.json'), null);
    if (!after || !existsSync(path.join(source, 'pr.diff'))) {
      throw new Error(`${source} needs chapters.json and pr.diff to publish a rebuild`);
    }
    const diff = parseUnifiedDiff(readFileSync(path.join(source, 'pr.diff'), 'utf8'));
    const counts = vetRebuild(rebuild, before, after, diff, {
      allowUncovered: !!opts['allow-uncovered'],
    });
    if (counts.carried || counts.unmapped) {
      writeJsonAtomic(path.join(source, 'chapters.json'), after); // so the next build keeps them
    }
    rebuilt = { build: rebuild, before, after, counts };
  }
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
        number: prJson.number,
        url: prJson.url,
        pr_title: prJson.title || null,
        head_oid: prJson.headRefOid || null, // the commit the story was told from
        base_oid: prJson.baseRefOid || null,
        head_ref: prJson.headRefName || null, // the PR's branch, where a fix request's change goes
        source,
        published_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  let note = null;
  if (rebuilt) {
    note = afterRebuild(home, { id, stateKey: stateKeyOf(id, meta), ...rebuilt });
    process.stderr.write(`${note}\n`);
  }
  // the story is here, so a Build story or Update request for the PR is done, and a rebuild with it published again
  builds.settle(repo, prJson.number, {
    story: id,
    head: prJson.headRefOid || null,
    published: true,
    note,
  });
  out(dest);
}

export const storyCommands: Command[] = [
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
      '  once-upon local   --repo DIR --base REF [--head REF] [--chapters FILE] [--id ID] [--title T] [--no-open] [--allow-uncovered]',
      '                                                                 story over local commits, served at /local/<id>/; with a Rebuild',
      '                                                                 pending, the chapters must keep what it keeps and tell every file and hunk',
    ],
    run: local,
  },
  {
    name: 'publish',
    usage: [
      '  once-upon publish --dir DIR [--id ID] [--allow-uncovered]     copy a once-upon folder into <checkout>/.once-upon/<owner>-<repo>-<N>/ (or ~/.once-upon/)',
      "                                                                 and finish the PR's build request; a Rebuild must keep what it keeps, tell",
      '                                                                 every file and hunk, and keeps the drafts the new chapters dropped',
    ],
    run: publish,
  },
];
