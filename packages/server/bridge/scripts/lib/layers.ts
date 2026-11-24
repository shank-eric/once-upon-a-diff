/*
 * Whether code in one file may call a predicate defined in another: the same rules as configs/.dependency-cruiser.mjs, kept small
 * here so restated-rules never advises an import the layers refuse. The order and tiers below are pinned to configs/layers.mjs by
 * packages/server/bridge/test/restated-rules.test.ts.
 */
export const ENGINE = ['adapters', 'foundation', 'stories', 'state', 'core', 'board'];
export const TIERED: Record<string, string[]> = {
  state: ['records', 'queues'],
  core: ['features', 'orchestration'],
};
/** The packages whose predicates are indexed: the domain's pure rules and the engine. */
export const INDEXED = ['terms', 'contracts', ...ENGINE];

export interface Place {
  group: string;
  name: string;
  /** the tier folder and the folder inside it, for a tiered package */
  tier: string | null;
  folder: string | null;
}

/** Where a repo-relative path sits: `packages/<group>/<name>/src/<tier>/<folder>/...`, or null outside packages. */
export function placeOf(file: string): Place | null {
  const [root, group, name, src, tier, folder] = file.split('/');
  if (root !== 'packages' || !group || !name) {
    return null;
  }
  const tiered = TIERED[name] !== undefined && src === 'src';
  return {
    group,
    name,
    tier: tiered ? (tier ?? null) : null,
    folder: tiered ? (folder ?? null) : null,
  };
}

/** Whether the file at `from` may import a predicate defined at `rule`. */
export function canCall(rule: Place, from: Place): boolean {
  if (rule.group === 'domain') {
    return !(rule.name === 'contracts' && from.name === 'terms') && from.name !== 'test-kit';
  }
  return fromEngine(rule, from);
}

function fromEngine(rule: Place, from: Place): boolean {
  if (from.group === 'server') {
    return !refusedToServerGroup(rule, from);
  }
  if (from.group !== 'server-libs') {
    return false;
  }
  const target = ENGINE.indexOf(rule.name);
  if (from.name === 'usage') {
    return target >= 0 && target <= ENGINE.indexOf('foundation');
  }
  const source = ENGINE.indexOf(from.name);
  if (source < 0 || target < 0) {
    return false;
  }
  return source === target ? sameTier(rule, from) : target < source;
}

/** What `apps-use-the-engine-not-adapters` and `board-is-the-servers` refuse a file in the server group: adapters to the HTTP app and the CLI, board to all but the HTTP app. */
function refusedToServerGroup(rule: Place, from: Place): boolean {
  const isApp = from.name === 'server' || from.name === 'cli';
  return (isApp && rule.name === 'adapters') || (rule.name === 'board' && from.name !== 'server');
}

/** Inside one tiered package a tier imports only the tiers under it, and the folders of one tier never import each other. */
function sameTier(rule: Place, from: Place): boolean {
  if (rule.tier === null || from.tier === null) {
    return true;
  }
  const order = TIERED[rule.name] ?? [];
  const target = order.indexOf(rule.tier);
  const source = order.indexOf(from.tier);
  return target < source || (target === source && rule.folder === from.folder);
}
