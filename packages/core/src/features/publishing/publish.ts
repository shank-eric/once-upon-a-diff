import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { StoryStore } from '../../records/stories/store.ts';
import { Builds, type Build } from '../../queues/requests/builds.ts';
import { copyFileAtomic, readJson, writeJsonAtomic } from '../../adapters/stores/fs/json-file.ts';
import { parseUnifiedDiff } from '../../records/stories/diff.ts';
import { stateKeyOf } from '../../records/stories/meta.ts';
import { afterRebuild } from './after-rebuild.ts';
import { vetRebuild } from '../../records/stories/rebuild.ts';
import { slug } from '../../records/stories/local-story.ts';
import { storyDirFor } from '../../records/stories/placement.ts';
import { noteSkeleton } from '../../records/stories/skeleton.ts';
import { readyPlan } from '../../records/stories/validate.ts';
import type { Plan } from '../../records/stories/chapters.ts';
import type { StoryMeta } from '../../records/stories/types.ts';

/** A rebuild that's being published: its request, the chapters before and after, and the drafts carried over. */
export type Rebuilt = {
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
  author?: { login?: string } | null;
  headRefOid?: string;
  baseRefOid?: string;
  headRefName?: string;
}

/** The story's pending rebuild request, or null. */
export function pendingRebuild(builds: Builds, id: string, meta: StoryMeta): Build | null {
  const build = builds.rebuildOf(id, meta);
  return build && build.status === 'pending' ? build : null;
}

/**
 * Publishes a once-upon folder (what skills/once-upon's story.mjs built: pr.json, chapters.json, file-map.json, pr.diff) where
 * the bridge finds it, and settles the build request for the PR. Resolves to the story's id and folder, and the note a
 * rebuild leaves (null when this was not one). Throws with a message the CLI prints. `onNote` hears a rebuild's note once
 * the build request is settled, or when settling throws, so the note is not lost to a failure there.
 */
export function publishPrStory(
  home: string,
  {
    dir,
    id: wantedId,
    allowUncovered,
    onNote,
  }: { dir: string; id?: string; allowUncovered: boolean; onNote?: (note: string) => void },
): { id: string; dest: string; note: string | null } {
  const source = path.resolve(dir);
  const pr = readJson<PrJson>(path.join(source, 'pr.json'), null);
  const repo = pr && pr.url ? pr.url.split('/').slice(3, 5).join('/') : null;
  if (!repo || !pr!.number) {
    throw new Error(`${source} doesn't say which PR it is (no pr.json naming it)`);
  }
  const prJson = pr as PrJson & { number: number }; // named above
  const id = wantedId || slug(`${repo.replace('/', '-')}-${prJson.number}`);
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
      allowUncovered,
    });
    if (counts.carried || counts.unmapped) {
      writeJsonAtomic(path.join(source, 'chapters.json'), after); // so the next build keeps them
    }
    rebuilt = { build: rebuild, before, after, counts };
  }
  // into the repo's checkout (.once-upon/<id>, kept out of git) when the bridge knows it, else ~/.once-upon/<id>
  const dest = storyDirFor(home, id, { repo });
  // every chapter has a key and its refs, and the story's text links by them: refused here, not drawn wrong later
  const plan = readJson<Plan>(path.join(source, 'chapters.json'), null);
  if (plan) {
    const diffFile = path.join(source, 'pr.diff');
    const assigned = readyPlan(plan, {
      diff: existsSync(diffFile) ? parseUnifiedDiff(readFileSync(diffFile, 'utf8')) : undefined,
      served: readJson<Plan>(path.join(dest, 'chapters.json'), null),
    });
    if (assigned.length) {
      writeJsonAtomic(path.join(source, 'chapters.json'), plan); // so the author's next edit keeps the keys
    }
  }
  for (const name of ['chapters.json', 'file-map.json']) {
    if (existsSync(path.join(source, name))) {
      copyFileAtomic(path.join(source, name), path.join(dest, name));
    }
  }
  noteSkeleton(dest, readJson<Plan>(path.join(source, 'chapters.json'), {}) || {});
  writeJsonAtomic(path.join(dest, 'meta.json'), {
    kind: 'github',
    repo,
    number: prJson.number,
    url: prJson.url,
    pr_title: prJson.title || null,
    pr_author: prJson.author?.login || null, // whose PR it is: Fix before push is on only for the viewer's own
    head_oid: prJson.headRefOid || null, // the commit the story was told from
    base_oid: prJson.baseRefOid || null,
    head_ref: prJson.headRefName || null, // the PR's branch, where a fix request's change goes
    source,
    published_at: new Date().toISOString(),
  });
  let note: string | null = null;
  if (rebuilt) {
    note = afterRebuild(home, { id, stateKey: stateKeyOf(id, meta), ...rebuilt });
  }
  // the story is here, so a Build story or Update request for the PR is done, and a rebuild with it published again
  try {
    builds.settle(repo, prJson.number, {
      story: id,
      head: prJson.headRefOid || null,
      published: true,
      note,
    });
  } finally {
    if (note) {
      onNote?.(note);
    }
  }
  return { id, dest, note };
}
