/*
 * What a story folder says it is (meta.json), and the story a call is about. Types only. The story and the answers the
 * panel takes are in @once-upon-a-diff/shared/types.
 */
import type { LocalCommit } from '@once-upon-a-diff/shared/types';

/** A story folder's meta.json (readMeta fills in kind, title and a PR's url). */
export interface StoryMeta {
  kind: 'github' | 'local';
  title?: string;
  // a PR story
  repo?: string | null;
  number?: number | null;
  url?: string | null;
  pr_title?: string;
  /** the PR author's login, from pr.json when the story was published */
  pr_author?: string | null;
  head_oid?: string | null;
  head_ref?: string | null;
  /** the once-upon folder it was published from */
  source?: string | null;
  // a local story
  repo_path?: string;
  base?: string;
  head?: string;
  base_oid?: string | null;
  branch?: string | null;
  commits?: LocalCommit[];
  /** when the story was told (`once-upon local`, a rebuild), not when its diff was last refreshed (`updated_at`) */
  built_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/** A local story's meta.json: the checkout and the range it diffs. */
export type LocalMeta = StoryMeta & {
  kind: 'local';
  repo_path: string;
  base: string;
  head: string;
};

/** What inbox entries say about a story, with the repo for `wait --repo`. */
export interface StoryRef {
  story: string;
  kind: StoryMeta['kind'];
  title: string | undefined;
  repo: string | null;
}

/** The story a /api/stories/<id>/... call is about. sub is the path's last part, when there is one. */
export interface ServedStory {
  id: string;
  dir: string;
  meta: StoryMeta;
  ref: StoryRef;
  sub?: string;
}
