/*
 * What the panel needs from the app that mounts it, injected, so the panel names no host: not GitHub's DOM, not chrome.*,
 * not how the bridge is reached. The extension and the local page each hand one PanelHost to storyOverlay (overlay.ts).
 *
 *   createPage  the host page's diff: where its files, lines, Viewed toggles and expand controls are (read only)
 *   client      the bridge, as the contracts package's typed client: the extension's goes through its service worker, the local
 *               page's is a fetch with its page key
 *   storyId     the story the panel is showing (its routes' :id)
 *   pageUrl     the page's address as the bridge should record it (no key)
 *   rangeLink, backFromRange, canPostDrafts  what the host's own pages offer: the diff of just some commits, and posting drafts
 */
import type { Client } from '@once-upon-a-diff/bridge-client/client';
import type { Side } from '@once-upon-a-diff/terms/line-refs';
import type { ActionName } from '@once-upon-a-diff/terms/usage-actions';
import type { ExpandRow, FileBlock, TreeRow } from './diff-types.ts';

export type { FileBlock } from './diff-types.ts';

/** What a host page's adapter is built from: the story's files and the panel's own element ids (it never reads those). */
interface HostPageDeps {
  shaToPath: Map<string, string>;
  pathToSha: Map<string, string>;
  allPaths: Set<string>;
  hostId: string;
  panelId: string;
}

/** The host page's diff, for one story's files. Read only, except that the panel clicks what isSafeToClick allows. */
export interface HostPage {
  isDrawn(element: Element | null | undefined): boolean;
  labelOf(element: Element): string;
  /** The page's file blocks: el is what gets hidden. */
  fileBlocks(): FileBlock[];
  blockOf(rel: string): FileBlock | undefined;
  blocksByPath(): Map<string, FileBlock>;
  /** The cell for line `line` on `side` ('L' old, 'R' new) of a file, or null. */
  lineCell(rel: string, side: Side, line: number): Element | null;
  viewedToggleIn(el: Element): HTMLButtonElement | HTMLInputElement | null;
  /** true/false from the file header's Viewed toggle, null when the file isn't on the page, 'none' when it has no toggle. */
  isViewed(rel: string, blocks?: Map<string, FileBlock>): boolean | 'none' | null;
  /** Never a Viewed toggle, a checkbox or anything that submits: those aren't the panel's to click. */
  isSafeToClick(el: HTMLElement | null | undefined): el is HTMLElement;
  collapsedToggle(el: Element): HTMLElement | null;
  loadDiffButton(el: Element): HTMLElement | null;
  expandAllButton(el: Element): HTMLElement | null;
  rowModel(row: Element, sha: string, side: Side): ExpandRow;
  treeRows(): TreeRow[];
  /** The file at the top of the screen, else the next one down that shows. */
  fileAtTop(): string | null;
  /** The story file the page's current URL hash points at, or null. */
  fileOfHash(): string | null;
  /** Points the page's URL hash at a story file, in place. */
  hashToFile(rel: string): void;
}

/** The app's side of the panel. */
export interface PanelHost {
  createPage(deps: HostPageDeps): HostPage;
  client: Pick<Client, 'ask'>;
  storyId: string;
  pageUrl(): string;
  /** The link to the host's view of just the changes in `since` (a PR at `prUrl`), or null when the host has none. */
  rangeLink(
    prUrl: string | null | undefined,
    since: { from: string; to: string } | null | undefined,
  ): string | null;
  /** On the host's own view of `since`, the link back to all of the PR's changes; null anywhere else. */
  backFromRange(
    prUrl: string | null | undefined,
    since: { from: string; to: string },
  ): string | null;
  /** Whether drafted comments can be placed on the host's page (a PR's pending review, a gh script). */
  canPostDrafts: boolean;
  /** counts one UI-only action for the usage capture (the host sends the batch; the panel only names the action) */
  count(name: ActionName): void;
}
