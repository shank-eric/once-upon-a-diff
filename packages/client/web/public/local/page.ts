/*
 * The local page's shared state, and its one way to the bridge. The boot
 * block in the page names the story; its key comes in the link's #fragment, or from the one an earlier visit saved.
 */
import { createClient, type Transport } from '/assets/bridge-client/client.ts';
import { createUsage } from '/assets/bridge-client/usage.ts';
import { ROUTES } from '/assets/contracts/routes.ts';
import { dropKeyFromAddress, forgetKey, saveKey, savedKey } from '/assets/local/saved-key.ts';
import type { LocalStory, StoryData } from '/assets/types.ts';
import type { InitialUi, StoryOverlay } from '/assets/panel/shell/overlay.ts';
import type { Highlighter } from '/assets/local/diff/syntax.ts';
import type { Layout } from '/assets/panel/shell/layout.ts';

/** A local story: one with its diff and the bridge's state for it. */
export type LocalStoryData = StoryData & { local: LocalStory };

/** What the page's modules share (see page below). */
export interface LocalPage {
  overlay: StoryOverlay | null;
  lastUi: InitialUi;
  /** the panel's size across stories, as the bridge's prefs.json last had it */
  layout: Layout | null;
  hljs: Highlighter | null;
  onVersion: ((version?: string) => Promise<void>) | null;
}

// the bridge's page always has the boot block (server/pages.ts)
const BOOT: { story: string } = JSON.parse(
  (document.getElementById('ou-local-boot') as HTMLElement).textContent as string,
);

/**
 * The page's key for its story: the link's #key= (`once-upon local` and `once-upon page` open the keyed link and print the keyless
 * one), else the key an earlier visit saved. A key from the link is saved and taken out of the address bar once the bridge has
 * accepted it on a call (the transport below), so an old or refused link cannot replace a good saved key, and the keyless
 * link opens next time. The bridge takes it only for this story's routes, and the page itself carries no token.
 */
const FRAGMENT_KEY = new URLSearchParams(location.hash.slice(1)).get('key') || '';
const KEY = FRAGMENT_KEY || savedKey(BOOT.story);
/** The key came from storage, so a refusal means it is stale: the token changed since. */
const FROM_STORAGE = !FRAGMENT_KEY && !!KEY;
/** The link's key has been saved (after the bridge took it), so later calls skip that. */
let fragmentKeySaved = false;

/** The page's address without its #key, for what the page tells the bridge (position, questions). */
export const pageUrl = () => location.href.split('#')[0];

/** The story id, and the params every call on its routes takes. */
export const STORY_ID = BOOT.story;
export const PARAMS = { id: BOOT.story };

/**
 * What the page's modules share and the store (store.ts) doesn't draw: the panel (null while it's closed), the panel's last
 * saved state, its size across stories, highlight.js once it has loaded (null without it), and onVersion(version), the
 * page's reload, for the panel's pulse to call.
 */
export const page: LocalPage = {
  overlay: null,
  lastUi: {},
  layout: null,
  hljs: null,
  onVersion: null,
};

/**
 * The page's way to the bridge for the contracts package's client: a fetch with the page's key. It never rejects: a call that
 * didn't get there says so in its reply, and `bridge.ask` turns that into an Error with the bridge's message.
 */
const transport: Transport = async ({ method, path, body, signal }) => {
  if (!KEY) {
    return {
      ok: false,
      status: 0,
      error: `this browser has no key for this story: run \`once-upon page --story ${BOOT.story}\` in a terminal to open it`,
    };
  }
  try {
    const response = await fetch(path, {
      method,
      cache: 'no-store',
      signal,
      headers: {
        Authorization: `Bearer ${KEY}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = (json as { error?: string }).error;
      if (response.status === 401 && FROM_STORAGE) {
        forgetKey(BOOT.story); // saved before the token changed: say how to get a new one
        return {
          ok: false,
          status: response.status,
          body: json,
          error: `the key this browser saved is not accepted any more: run \`once-upon page --story ${BOOT.story}\` in a terminal to open it again`,
        };
      }
      return {
        ok: false,
        status: response.status,
        body: json,
        error: message || `HTTP ${response.status}`,
      };
    }
    if (FRAGMENT_KEY && !fragmentKeySaved) {
      fragmentKeySaved = true;
      if (saveKey(BOOT.story, FRAGMENT_KEY)) {
        dropKeyFromAddress();
      }
    }
    return { ok: true, status: response.status, body: json };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message };
  }
};

/** The typed calls to the bridge: `bridge.ask(ROUTES.name, {params: PARAMS, body})` answers or throws with the bridge's message. */
export const bridge = createClient(transport);

/** Counts the page's UI-only actions for the usage capture, sent to the bridge in batches (names and counts only). */
export const usage = createUsage(async (counts) => {
  const reply = await bridge.call(ROUTES.storyUsageCount, { params: PARAMS, body: { counts } });
  return reply.ok ? reply.body : null;
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    void usage.flush();
  }
});
