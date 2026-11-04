/*
 * The usage capture's closed lists. A page counts a UI action by naming one of ACTIONS, and nothing else can be sent or
 * stored (the bridge drops any other name), so a count can never carry story text, ids, paths or what someone typed.
 * Only actions that never reach the bridge are listed: whatever calls a bridge route is counted by the bridge itself,
 * under the route's name. Each action names the feature area it belongs to, the tool map's areas, so counts tie back to
 * code. Imports nothing, so pages and the extension load it.
 */

/** The feature areas of the static tool map (notes/research/2026-11-04-ou-tool-map.md, section 1). */
export const AREAS = [
  'Story pipeline',
  'Panel',
  'Local story page',
  'Board backend',
  'Board frontend',
  'Inbox, Q&A, fix and build requests',
  'Listeners and sessions',
  'Review',
  'Backlog',
  'Ledger and agent registry',
  'Worktrees',
  'Voice',
  'Settings, config and doctor',
  'Protocol and api-client',
  'Server shell',
  'Deploy',
  'Extension',
] as const;
export type Area = (typeof AREAS)[number];

/** Every UI-only action a page, the panel or the extension may count. */
export const ACTIONS = {
  // the panel, on GitHub (the extension) and on the local page
  'panel.step.next': { area: 'Panel' },
  'panel.step.prev': { area: 'Panel' },
  'panel.step.jump': { area: 'Panel' },
  'panel.collapse': { area: 'Panel' },
  'panel.close': { area: 'Panel' },
  'panel.file.jump': { area: 'Panel' },
  'panel.filter.toggle': { area: 'Panel' },
  'panel.viewed.mark': { area: 'Panel' },
  'panel.dock.toggle': { area: 'Inbox, Q&A, fix and build requests' },
  'panel.qa.expand': { area: 'Inbox, Q&A, fix and build requests' },
  'panel.qa.collapse': { area: 'Inbox, Q&A, fix and build requests' },
  'panel.draft.copy': { area: 'Review' },
  'panel.draft.script': { area: 'Review' },
  'panel.light.open': { area: 'Listeners and sessions' },
  // the local story page
  'local.fold.toggle': { area: 'Local story page' },
  'local.tree.goto': { area: 'Local story page' },
  'local.notes.toggle': { area: 'Local story page' },
  'local.line.open': { area: 'Local story page' },
  // the agent board
  'board.tab.switch': { area: 'Board frontend' },
  'board.filter.repo': { area: 'Board frontend' },
  'board.lane.toggle': { area: 'Board frontend' },
  'board.idle.toggle': { area: 'Board frontend' },
  'board.notes.copy': { area: 'Board frontend' },
  'board.voice.tab': { area: 'Voice' },
  'board.backlog.addOpen': { area: 'Backlog' },
  // the extension
  'ext.toolbar.toggle': { area: 'Extension' },
  'ext.shortcut.togglePanel': { area: 'Extension' },
  'ext.shortcut.openBoard': { area: 'Extension' },
  'ext.prTag.click': { area: 'Extension' },
  'ext.options.save': { area: 'Settings, config and doctor' },
  'ext.options.test': { area: 'Settings, config and doctor' },
  'ext.options.openBoard': { area: 'Settings, config and doctor' },
} as const satisfies Record<string, { area: Area }>;

export type ActionName = keyof typeof ACTIONS;

/** Whether a string is one of the listed actions. */
export const isActionName = (name: string): name is ActionName => Object.hasOwn(ACTIONS, name);

/** The most entries one batch may carry, and the largest count one entry may add. */
export const MAX_BATCH_ENTRIES = 200;
export const MAX_ACTION_COUNT = 10000;

/** What counting a batch answers: whether the capture is on (a page that hears false stops sending). */
export interface UsageAnswer {
  on: boolean;
}
