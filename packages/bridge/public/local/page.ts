/*
 * The local page's shared state, and its one way to the bridge. The boot
 * block in the page names the story; its key comes in the link's #fragment.
 */
import type { LocalStory, StoryData } from '/assets/types.ts';
import type { InitialUi, StoryOverlay } from '/assets/overlay.ts';
import type { Highlighter } from '/assets/syntax.ts';

/** A local story: one with its diff and the bridge's state for it. */
export type LocalStoryData = StoryData & { local: LocalStory };

/** What the page's modules share (see page below). */
export interface LocalPage {
  story: LocalStoryData;
  overlay: StoryOverlay | null;
  hidden: boolean;
  lastUi: InitialUi;
  hljs: Highlighter | null;
  onVersion: ((version?: string) => Promise<void>) | null;
}

// the bridge's page always has the boot block (server/pages.ts)
const BOOT: { story: string } = JSON.parse(
  (document.getElementById('ou-local-boot') as HTMLElement).textContent as string,
);

/**
 * The page's key for its story, from the link's #key= (`once-upon local` and `once-upon page` print the link). The
 * bridge takes it only for this story's routes, and the page itself carries no token.
 */
const KEY = new URLSearchParams(location.hash.slice(1)).get('key') || '';

/** The page's address without its #key, for what the page tells the bridge (position, questions). */
export const pageUrl = () => location.href.split('#')[0];

/** The story id, and its /api/stories/<id> path. */
export const STORY_ID = BOOT.story;
export const STORY_PATH = `/api/stories/${encodeURIComponent(BOOT.story)}`;

/**
 * What the page's modules share: the story (with its local diff), the panel (null while it's closed), whether the
 * reviewer closed it, the panel's last saved state, highlight.js once it has loaded (null without it), and
 * onVersion(version), local.js's reload, for the panel's pulse to call.
 */
export const page: LocalPage = {
  // null until local.ts has loaded it, before anything else reads it
  story: null as unknown as LocalStoryData,
  overlay: null,
  hidden: false,
  lastUi: {},
  hljs: null,
  onVersion: null,
};

/** A bridge call with the page's key. Rejects with the bridge's error message. */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  if (!KEY) {
    throw new Error(
      `this link has no key: open the page from the link \`once-upon page --story ${BOOT.story}\` prints`,
    );
  }
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: T & { error?: string } = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.error || `HTTP ${response.status}`);
  }
  return json;
}
