/*
 * The local page's shared state, and its one way to the bridge. The boot
 * block in the page names the story and carries the token.
 */

const BOOT = JSON.parse(document.getElementById('ds-boot').textContent);

/** The story id, and its /api/stories/<id> path. */
export const STORY_ID = BOOT.story;
export const STORY_PATH = `/api/stories/${encodeURIComponent(BOOT.story)}`;

/**
 * What the page's modules share: the story (with its local diff), the panel (null while it's closed), whether the
 * reviewer closed it, the panel's last saved state, and highlight.js once it has loaded (null without it).
 */
export const page = { story: null, overlay: null, hidden: false, lastUi: {}, hljs: null };

/** A bridge call with the page's token. Rejects with the bridge's error message. */
export async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${BOOT.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.error || `HTTP ${response.status}`);
  }
  return json;
}
