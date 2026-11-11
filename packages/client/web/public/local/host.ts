import type { PanelHost } from '/assets/panel/host/host.ts';

/** The local page's side of the panel host's link members: it has no host range page, and drafts aren't posted from it. */
export const LOCAL_HOST_LINKS: Pick<PanelHost, 'rangeLink' | 'backFromRange' | 'canPostDrafts'> = {
  rangeLink: () => null,
  backFromRange: () => null,
  canPostDrafts: false,
};
