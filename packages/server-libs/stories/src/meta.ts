/*
 * What a story folder is: whether it is one (chapters.json and meta.json),
 * what it's a story of (readMeta), and its version, which the pages poll to
 * redraw when a file changes.
 */
import { stateKeyForPr } from '@once-upon-a-diff/terms/ids';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { readJson } from '@once-upon-a-diff/adapters/stores/fs/json-file';
import type { LocalMoved } from '@once-upon-a-diff/contracts/types';
import { repoOfCheckout } from '@once-upon-a-diff/foundation/repos';
import type { Prefs } from '@once-upon-a-diff/foundation/settings';
import type { StoryMeta } from './types.ts';
import { prUrl } from '@once-upon-a-diff/terms/github-urls';
import { shortSha } from '@once-upon-a-diff/terms/text';
import { chapterKeyOf } from '@once-upon-a-diff/terms/chapters';
import { FULL_SHA_RE } from '@once-upon-a-diff/terms/patterns';
import { inCheckout, realPathOf, recordKind, recordedKind } from './placement.ts';
import { homeDir } from '@once-upon-a-diff/foundation/settings';

/** A file's modification time in ms, or 0 when it's missing. */
function modifiedAt(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export const isStoryDir = (dir: string): boolean =>
  existsSync(path.join(dir, 'chapters.json')) && existsSync(path.join(dir, 'meta.json'));

const STORY_KINDS = ['github', 'local'];

/**
 * A ref or branch a meta.json may name: what git allows in a ref name or a revision like `HEAD~1` (letters, digits and
 * `. _ / + - ~ ^ @`) and nothing a shell reads specially: no dollar, backtick, quote, backslash, `;`, `&`, `|`, `<`, `>`,
 * parentheses, braces, `*` or space. Not an
 * option (no leading `-`), no `..`, no `@{`, no `//`, and no empty, `.`-led or `.lock`-ended path part.
 */
export const isSafeRef = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 255 &&
  /^[A-Za-z0-9._/+~^@-]+$/.test(value) &&
  !value.startsWith('-') &&
  !value.includes('..') &&
  !value.includes('@{') &&
  !value.endsWith('/') &&
  !value.endsWith('.') &&
  value.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));

/** The meta.json as an object, or null when it is anything else. */
const plainObject = (raw: Partial<StoryMeta> | null | undefined): Partial<StoryMeta> | null =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;

/** Why a story's `kind` is not one of STORY_KINDS, or null. */
const kindProblem = (kind: unknown): string | null =>
  typeof kind === 'string' && STORY_KINDS.includes(kind)
    ? null
    : `kind ${JSON.stringify(kind)} is not one of ${STORY_KINDS.join(', ')}`;

const OID_FIELDS = ['base_oid', 'head_oid', 'told_head_oid', 'told_base_oid'] as const;
const OPTIONAL_REF_FIELDS = ['head_ref', 'branch'] as const;
const REQUIRED_REF_FIELDS = ['base', 'head'] as const;

/** Each oid the meta names that is not a full sha becomes null. */
function dropBadOids(meta: StoryMeta): void {
  for (const field of OID_FIELDS) {
    if (
      meta[field] != null &&
      !(typeof meta[field] === 'string' && FULL_SHA_RE.test(meta[field]))
    ) {
      meta[field] = null;
    }
  }
}

/** Each `head_ref` or `branch` the meta names that is not a safe ref becomes null. */
function dropBadRefs(meta: StoryMeta): void {
  for (const field of OPTIONAL_REF_FIELDS) {
    if (meta[field] != null && !isSafeRef(meta[field])) {
      meta[field] = null;
    }
  }
}

/** Drops a `base` or `head` that is not a safe ref, and says so. */
function dropRequiredRef(
  meta: StoryMeta,
  field: (typeof REQUIRED_REF_FIELDS)[number],
): string | null {
  if (meta[field] === undefined || isSafeRef(meta[field])) {
    return null;
  }
  delete meta[field];
  return `${field} is not a ref`;
}

/** Why a local story's `repo_path` is not to be trusted (it is dropped), or null: an absolute path, the checkout that holds the folder. */
function repoPathProblem(meta: StoryMeta, dir: string, home: string): string | null {
  if (typeof meta.repo_path !== 'string' || !path.isAbsolute(meta.repo_path)) {
    delete meta.repo_path;
    return 'repo_path is not a folder';
  }
  const held = inCheckout(dir, home);
  const holder = held ? realPathOf(path.dirname(path.dirname(dir))) : null;
  if (held && (!holder || realPathOf(meta.repo_path) !== holder)) {
    delete meta.repo_path;
    return "repo_path is not the checkout that holds the story's folder";
  }
  return null;
}

/** What is wrong with a local story's own fields, in the order they are checked. */
function localProblems(meta: StoryMeta, dir: string, home: string): (string | null)[] {
  return [
    repoPathProblem(meta, dir, home),
    meta.base && meta.head ? null : 'a local story needs base and head',
  ];
}

/**
 * What a meta.json may be trusted to say. A folder in a checkout's .once-upon/ can be overwritten by a branch that tracks
 * files there, so its meta.json is checked before any field reaches git: an oid must be a full sha and a ref or branch
 * must not be an option (either is dropped), `kind` must be one of STORY_KINDS, and a local story's `repo_path` must
 * be the checkout that holds its folder (<repo_path>/.once-upon/<id>; both compared by real path). A story in the
 * bridge's own folder (`home`: told by its path, see placement.ts inCheckout; no branch can write it) keeps whatever
 * checkout it names, as long as it is an absolute path.
 * `meta` is the cleaned copy (bad fields dropped, `repo_path` too when it is not the folder's checkout); `problem` says
 * why the story is not to be served or diffed, null when there is none.
 */
export function checkedMeta(
  dir: string,
  raw: Partial<StoryMeta> | null | undefined,
  home: string = homeDir(),
): { meta: StoryMeta; problem: string | null } {
  const fields = plainObject(raw);
  const kind = fields?.kind || 'github';
  const badKind = kindProblem(kind);
  const meta: StoryMeta = { ...fields, kind: badKind ? 'github' : (kind as StoryMeta['kind']) };
  dropBadOids(meta);
  dropBadRefs(meta);
  // every check runs, since each cleans its fields; the first problem found is the one reported
  const problems = [
    fields ? null : 'meta.json is not an object',
    badKind,
    ...REQUIRED_REF_FIELDS.map((field) => dropRequiredRef(meta, field)),
    ...(meta.kind === 'local' ? localProblems(meta, dir, home) : []),
  ];
  return { meta, problem: problems.find(Boolean) ?? null };
}

/**
 * Why a story is not to be served, or null. Its meta.json is checked (checkedMeta), and for a folder in a checkout its
 * `kind` must be the one recorded when the story was made (placement.ts recordKind): a story made before the record is
 * taken as it is the first time it is seen, and that is the kind recorded.
 */
export function refusalOf(home: string, id: string, dir: string): string | null {
  if (!inCheckout(dir, home)) {
    return null; // the bridge's own folder (<home>/<id>, told by its path, not its name): no branch writes there
  }
  const { meta, problem } = checkedMeta(
    dir,
    readJson<Partial<StoryMeta>>(path.join(dir, 'meta.json'), {}),
    home,
  );
  if (problem) {
    return problem;
  }
  const recorded = recordedKind(home, id);
  if (recorded && recorded !== meta.kind) {
    return `kind ${meta.kind} is not the ${recorded} this story was made as`;
  }
  if (!recorded) {
    recordKind(home, id, meta.kind);
  }
  return null;
}

/** The key of the chapter at 1-based `step` in the story's chapters.json, or null when the story or the chapter can't be read. */
export function chapterKeyAt(dir: string, step: number): string | null {
  const plan = readJson<{ chapters?: unknown[] }>(path.join(dir, 'chapters.json'), {}) || {};
  const chapter = Array.isArray(plan.chapters) ? plan.chapters[step - 1] : null;
  return chapter && typeof chapter === 'object'
    ? chapterKeyOf(chapter as { key?: unknown; title?: unknown }) || null
    : null;
}

/** What a story folder is about, from its meta.json (checked: see checkedMeta): {kind, repo, number, title, url, head_oid, ...}. */
export function readMeta(dir: string): StoryMeta & { title: string } {
  const raw = readJson<Partial<StoryMeta>>(path.join(dir, 'meta.json'), {}) || {};
  const plan = readJson<{ title?: string }>(path.join(dir, 'chapters.json'), {}) || {};
  const out: StoryMeta = checkedMeta(dir, raw).meta;
  if (out.kind === 'github' && out.repo && out.number && !out.url) {
    out.url = prUrl(out.repo, out.number);
  }
  out.title = plan.title || out.title || out.pr_title || path.basename(dir);
  return out as StoryMeta & { title: string };
}

export function storyVersion(dir: string): string {
  const files = ['chapters.json', 'file-map.json', 'meta.json', 'local.diff'];
  return String(Math.max(...files.map((name) => modifiedAt(path.join(dir, name)))));
}

/**
 * A local story's version also says whether whitespace is hidden and which diff view is on, so a page
 * that polls it redraws when a setting changes in another tab, and where a pinned story's branch has moved to,
 * so the page draws its "branch moved" notice.
 */
export const localVersion = (
  dir: string,
  prefs: Prefs | null,
  moved: LocalMoved | null = null,
): string =>
  storyVersion(dir) +
  (prefs && prefs.hideWhitespace ? '-w' : '') +
  (prefs && prefs.diffView === 'split' ? '-s' : '') +
  (moved ? `-m${shortSha(moved.head_oid)}${shortSha(moved.base_oid)}` : '');

/**
 * The login of a PR story's author: from its meta.json (`pr_author`, written when it was published), else from the
 * pr.json beside the story or in the once-upon folder it was published from (a story made before meta.json kept it).
 * Null when none says.
 */
export function prAuthorOf(dir: string, meta: StoryMeta): string | null {
  if (meta.pr_author) {
    return meta.pr_author;
  }
  for (const folder of [dir, meta.source]) {
    if (folder) {
      const pr = readJson<{ author?: { login?: string } | null }>(
        path.join(folder, 'pr.json'),
        null,
      );
      if (pr && pr.author && pr.author.login) {
        return pr.author.login;
      }
    }
  }
  return null;
}

/** The story's meta.json as it is on disk (nothing filled in), or {} when it is missing or not JSON. */
export const readStoredMeta = (dir: string): StoryMeta =>
  readJson<StoryMeta>(path.join(dir, 'meta.json'), {} as StoryMeta) as StoryMeta;

/** A story's repo: a PR story's own, or a local story's checkout's origin. */
export function storyRepo(meta: StoryMeta | null | undefined): string | null {
  if (!meta) {
    return null;
  }
  if (meta.kind === 'local') {
    return meta.repo || repoOfCheckout(meta.repo_path);
  }
  return meta.repo || null;
}

/** Where a story's reads, marks and drafts live: a PR story's own key, so every story of the PR shares them, else its id. */
export const stateKeyOf = (id: string, meta: StoryMeta | null | undefined): string =>
  meta && meta.kind === 'github' && meta.repo && meta.number
    ? stateKeyForPr(meta.repo, meta.number)
    : id;
