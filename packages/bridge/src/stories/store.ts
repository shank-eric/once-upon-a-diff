/**
 * Finding and loading stories.
 *
 * A story is a folder holding chapters.json (once-upon's format) and a
 * meta.json saying what it is a story of. The bridge only reads story
 * folders. What it records (viewed files, notes, position, the panel's step)
 * goes under <home>/state/<story id>/.
 *
 * A story lives in one place (placement.ts): <checkout>/.once-upon/<id>/,
 * recorded in the index, or <home>/<id>/ when its repo has no known checkout.
 * The index is read first, so its folder wins for an id.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from '../util/json-file.ts';
import { readIndex } from './placement.ts';
import { stateFile } from '../config/settings.ts';
import { ID_RE, isStoryDir, readMeta, storyVersion } from './meta.ts';
import { storyData } from './story-data.ts';
import type { StoryData } from '@once-upon-a-diff/shared/types';

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

export class StoryStore {
  declare home: string;
  constructor({ home }: { home: string }) {
    this.home = home;
  }

  /** [{id, dir}] in priority order, ids unique. */
  dirs(): { id: string; dir: string }[] {
    const seen = new Map<string, string>();
    const add = (dir: string) => {
      const id = path.basename(dir);
      if (ID_RE.test(id) && !seen.has(id)) {
        seen.set(id, dir);
      }
    };
    for (const dir of Object.values(readIndex(this.home))) {
      if (typeof dir === 'string' && isStoryDir(dir)) {
        add(dir);
      }
    }
    for (const dir of childDirs(this.home)) {
      if (isStoryDir(dir)) {
        add(dir);
      }
    }
    return [...seen].map(([id, dir]) => ({ id, dir }));
  }

  dirOf(id: string): string | null {
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
  find(repo: string, number: number | string) {
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

  readState<T>(id: string, name: string, fallback: T): T | null {
    return readJson<T>(stateFile(this.home, id, name), fallback);
  }
  writeState(id: string, name: string, value: unknown): void {
    writeJson(stateFile(this.home, id, name), value);
  }

  /** The story as the panel takes it (the overlay's data), plus the diff and bridge state for a local story. */
  load(id: string): StoryData | null {
    const dir = this.dirOf(id);
    return dir ? storyData(this, id, dir) : null;
  }
}
