/**
 * Finding and loading stories.
 *
 * A story is a folder holding chapters.json (pr-story's format) and either
 * file-map.json, meta.json or pr.json saying what it is a story of. The bridge
 * only reads story folders. What it records (viewed files, notes, position,
 * the panel's step) goes under <home>/state/<story id>/.
 *
 * Roots, searched in order (the first story with a given id wins):
 *   1. stories in repo checkouts (<checkout>/.diff-story/<id>/): the index, then each known checkout's folder
 *   2. <home> itself (~/.diff-story/<owner>-<repo>-<N>/, local-*), or the --root folders
 *   3. pr-story's scratch folders, newest first
 * Stories that land in <home> (pr-story's render publishes there) move into their checkout once it's known (placement.mjs).
 */
import { readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { scratchBases } from '../config/settings.mjs';
import { readCheckouts } from '../config/repos.mjs';
import { readJson, writeJson } from '../util/json-file.mjs';
import { readIndex, adoptHomeStories, STORY_FOLDER } from './placement.mjs';
import { ID_RE, modifiedAt, isStoryDir, readMeta, storyVersion } from './meta.mjs';
import { storyData } from './story-data.mjs';

function childDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/** pr-story scratch story folders: <base>/<project>/<session>/scratchpad/pr-story/<name>/ */
export function scratchStoryDirs(bases = scratchBases()) {
  const out = [];
  for (const base of bases) {
    for (const project of childDirs(base)) {
      for (const session of childDirs(project)) {
        for (const dir of childDirs(path.join(session, 'scratchpad', 'pr-story'))) {
          if (isStoryDir(dir)) {
            out.push(dir);
          }
        }
      }
    }
  }
  return out.sort(
    (first, second) =>
      modifiedAt(path.join(second, 'chapters.json')) -
      modifiedAt(path.join(first, 'chapters.json')),
  );
}

export class StoryStore {
  /** @param {{home: string, roots?: string[], scratch?: boolean|string[]}} opts */
  constructor({ home, roots, scratch = true, adopt = true }) {
    this.home = home;
    this.roots = roots && roots.length ? roots : [home];
    this.scratch = scratch;
    this.adopt = adopt && !(roots && roots.length); // --root folders are someone else's: read them in place
  }

  /** [{id, dir}] in priority order, ids unique. */
  dirs() {
    const seen = new Map();
    const add = (dir) => {
      const id = path.basename(dir);
      if (ID_RE.test(id) && !seen.has(id)) {
        seen.set(id, dir);
      }
    };
    if (this.adopt) {
      adoptHomeStories(this.home, { isStoryDir });
    }
    for (const dir of Object.values(readIndex(this.home))) {
      if (typeof dir === 'string' && isStoryDir(dir)) {
        add(dir);
      }
    }
    for (const checkout of Object.values(readCheckouts(this.home))) {
      for (const dir of childDirs(path.join(checkout, STORY_FOLDER))) {
        if (isStoryDir(dir)) {
          add(dir);
        }
      }
    }
    for (const root of this.roots) {
      for (const dir of childDirs(root)) {
        if (isStoryDir(dir)) {
          add(dir);
        }
      }
    }
    if (this.scratch) {
      for (const dir of scratchStoryDirs(Array.isArray(this.scratch) ? this.scratch : undefined)) {
        add(dir);
      }
    }
    return [...seen].map(([id, dir]) => ({ id, dir }));
  }

  dirOf(id) {
    if (!ID_RE.test(String(id))) {
      return null;
    }
    const hit = this.dirs().find((candidate) => candidate.id === id);
    return hit ? hit.dir : null;
  }

  list() {
    return this.dirs().map(({ id, dir }) => {
      const meta = readMeta(dir);
      return {
        id,
        kind: meta.kind,
        title: meta.title,
        repo: meta.repo || null,
        number: meta.number || null,
        url: meta.url || null,
        dir,
        version: storyVersion(dir),
      };
    });
  }

  /** The newest GitHub story for owner/repo#number. Repo names compare case-insensitively, as GitHub's do. */
  find(repo, number) {
    const want = String(repo).toLowerCase();
    const hits = this.list().filter(
      (story) =>
        story.kind === 'github' &&
        String(story.repo).toLowerCase() === want &&
        Number(story.number) === Number(number),
    );
    hits.sort((first, second) => Number(second.version) - Number(first.version));
    return hits[0] || null;
  }

  stateDir(id) {
    const dir = path.join(this.home, 'state', id);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  readState(id, name, fallback) {
    return readJson(path.join(this.stateDir(id), name), fallback);
  }
  writeState(id, name, value) {
    writeJson(path.join(this.stateDir(id), name), value);
  }

  /** The story as the panel takes it (the overlay's data), plus the diff and bridge state for a local story. */
  load(id) {
    const dir = this.dirOf(id);
    return dir ? storyData(this, id, dir) : null;
  }
}
