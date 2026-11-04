/*
 * The parts of a repo, as its parts file names them (`.once-upon-parts.json` in a checkout's root, or
 * `<home>/parts/<owner>-<name>.json`), and which of them a story's chapters touch. Written once by hand, so the names stay
 * stable and nothing is generated per build. Pure rules: no imports (the domain sits below the wire types, so the types
 * the story carries are declared here and types.ts takes them from here).
 *
 * A part owns `paths`: a folder prefix (ends in "/") or one exact file. The longest match wins, so a part can carve a
 * subfolder out of another. A file no part owns falls in the implicit last part `other`.
 */

/** One part in a parts file. */
export interface PartDef {
  id: string;
  name: string;
  group: string;
  paths: string[];
  note?: string;
}

/** A repo's parts file (version 1). */
export interface PartsFile {
  version: 1;
  groups: string[];
  parts: PartDef[];
}

/** A part as the panel draws it. */
export interface StoryPart {
  id: string;
  name: string;
  group: string;
  note?: string;
}

/** The parts a story draws: the repo's, in draw order, and which each chapter touches. */
export interface StoryParts {
  /** group draw order */
  groups: string[];
  /** part draw order, with `other` last when a file of the story matches none */
  parts: StoryPart[];
  /** index = the story's chapters index: the ids of the parts its files touch */
  by_chapter: string[][];
  /** part id: how many of the story's files are in it */
  files: Record<string, number>;
}

export const OTHER_PART_ID = 'other';

const ID_RE = /^[a-z0-9-]{1,40}$/;
const MAX_PARTS = 40;
const MAX_PATHS = 50;
const MAX_NAME = 24;
const MAX_GROUP = 24;
const MAX_NOTE = 200;
const MAX_PATH = 300;

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/**
 * A path as the matcher wants it: `\` becomes `/` and leading `./` goes, so a typo in a personal file still matches. An
 * absolute path (`/x`, `C:/x`) or one that normalizes to nothing is null.
 */
function normalizePath(path: string): string | null {
  let out = path.replace(/\\/g, '/');
  while (out.startsWith('./')) {
    out = out.slice(2);
  }
  return out === '' || out.startsWith('/') || /^[A-Za-z]:/.test(out) ? null : out;
}

/**
 * A parts file read as JSON, checked: the file, or null when it isn't a valid version 1 file (a bad file shows no strip).
 * Paths are normalized (see normalizePath); an absolute path refuses the file, and `warn` hears why.
 */
export function parsePartsFile(raw: unknown, warn?: (line: string) => void): PartsFile | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const { version, groups, parts } = raw as Record<string, unknown>;
  if (version !== 1 || !Array.isArray(groups) || !Array.isArray(parts)) {
    return null;
  }
  if (parts.length > MAX_PARTS || groups.length > MAX_PARTS) {
    return null;
  }
  if (
    !groups.every((group) => isText(group, MAX_GROUP)) ||
    new Set(groups).size !== groups.length
  ) {
    return null;
  }
  const ids = new Set<string>();
  const out: PartDef[] = [];
  for (const entry of parts as Record<string, unknown>[]) {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    const { id, name, group, paths, note } = entry;
    if (
      typeof id !== 'string' ||
      !ID_RE.test(id) ||
      id === OTHER_PART_ID ||
      ids.has(id) ||
      !isText(name, MAX_NAME) ||
      typeof group !== 'string' ||
      !groups.includes(group) ||
      !Array.isArray(paths) ||
      paths.length > MAX_PATHS ||
      !paths.every((one) => isText(one, MAX_PATH)) ||
      (note !== undefined && !isText(note, MAX_NOTE))
    ) {
      return null;
    }
    const clean = (paths as string[]).map(normalizePath);
    if (clean.some((one) => one === null)) {
      warn?.(`part "${id}" has an absolute or empty path; paths are relative to the repo root`);
      return null;
    }
    ids.add(id);
    out.push({
      id,
      name,
      group,
      paths: clean as string[],
      ...(note === undefined ? {} : { note }),
    });
  }
  return { version: 1, groups: groups as string[], parts: out };
}

/** The part a file is in: the longest of its parts' paths that matches it, else `other`. */
export function partOf(rel: string, file: PartsFile): string {
  let best = OTHER_PART_ID;
  let length = -1;
  for (const part of file.parts) {
    for (const path of part.paths) {
      const matches = path.endsWith('/') ? rel.startsWith(path) : rel === path;
      if (matches && path.length > length) {
        best = part.id;
        length = path.length;
      }
    }
  }
  return best;
}

/** The parts the files touch, once each, in the file's part order (`other` last). */
export function touchedParts(rels: string[], file: PartsFile): string[] {
  const found = new Set(rels.map((rel) => partOf(rel, file)));
  const ordered = file.parts.map((part) => part.id).filter((id) => found.has(id));
  return found.has(OTHER_PART_ID) ? [...ordered, OTHER_PART_ID] : ordered;
}

/**
 * What the story draws: the parts, which each chapter touches (`chapterRels[i]` is chapter i's file paths) and how many of
 * the story's files (`allRels`) each part holds. `other` is listed only when a file lands in it.
 */
export function storyPartsOf(
  file: PartsFile,
  chapterRels: string[][],
  allRels: string[],
): StoryParts {
  const files: Record<string, number> = {};
  for (const rel of allRels) {
    const id = partOf(rel, file);
    files[id] = (files[id] || 0) + 1;
  }
  const byChapter = chapterRels.map((rels) => touchedParts(rels, file));
  const parts: StoryPart[] = file.parts.map(({ id, name, group, note }) => ({
    id,
    name,
    group,
    ...(note === undefined ? {} : { note }),
  }));
  const groups = [...file.groups];
  const usesOther = files[OTHER_PART_ID] || byChapter.some((ids) => ids.includes(OTHER_PART_ID));
  if (usesOther) {
    parts.push({ id: OTHER_PART_ID, name: 'Other', group: 'Other' });
    // a file's own group named "Other" takes the implicit part in, rather than drawing a second one
    if (!groups.includes('Other')) {
      groups.push('Other');
    }
  }
  return { groups, parts, by_chapter: byChapter, files };
}
