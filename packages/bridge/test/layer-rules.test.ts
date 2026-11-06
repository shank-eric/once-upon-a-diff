/*
 * Probes for every rule in configs/.dependency-cruiser.mjs. A temp tree shaped like the repo's packages holds one file per probe;
 * the repo's config runs over it, and each probe must trip its rule(s) and nothing else does. A forbidden import must be reported
 * under that rule's name; the allowed import beside it (expected: none) must not be. A rule whose path stops matching (a renamed
 * tier, a moved package, a broken `from` or `to`) goes quiet and fails here, and a second test fails when a rule has no probe at
 * all, so a new rule cannot land without one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { TIERS } from '../../../configs/core-tiers.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DEPCRUISE = path.join(ROOT, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs');
const CONFIG = path.join(ROOT, 'configs/.dependency-cruiser.mjs');

/** An import written as is (a Node built-in, an npm package, an /assets/ URL), not a path to a file of the tree. */
const spec = (specifier: string) => ({ spec: specifier });
type Target = string | { spec: string };
/** [probe file, what it imports, the rule(s) that must fire (null: it is allowed), 'type' for `import type`]. Paths are under packages/. */
type Probe = [string, Target, string | string[] | null, 'type'?];

// the tier probes below name the five tiers by position (bottom to top, as core-tiers.mjs lists them), and two folders in each tier
// that has folders: a new tier is a new probe, and this fails until it has one
assert.equal(TIERS.length, 5, 'layer-rules.test.ts probes five tiers: add the new tier’s probes');
const FOUNDATION = `core/src/${TIERS[0]}`;
const [RECORDS_A, RECORDS_B] = ['stories', 'agents'].map((name) => `core/src/${TIERS[1]}/${name}`);
const [QUEUES_A, QUEUES_B] = ['requests', 'backlog'].map((name) => `core/src/${TIERS[2]}/${name}`);
const [FEATURES_A, FEATURES_B] = ['review', 'sessions'].map(
  (name) => `core/src/${TIERS[3]}/${name}`,
);
const [ORCHESTRATION_A, ORCHESTRATION_B] = ['board', 'bridge'].map(
  (name) => `core/src/${TIERS[4]}/${name}`,
);
const TIER_FOLDERS = [FOUNDATION, RECORDS_A, QUEUES_A, FEATURES_A, ORCHESTRATION_A]; // one folder per tier, bottom to top
const BELOW_RULES = TIERS.slice(0, -1).map((tier) => `core-${tier}-below`); // the top tier has none

const SHIPPED = 'shipped-code-not-the-test-kit';
const EXT_APP = 'extension-is-an-app';
const SERVER_ONLY = 'bridge-is-server-only';
const NOT_CLIENT = 'bridge-not-the-client';
const HOST_FREE = 'panel-is-host-agnostic';
const CLIENT_BELOW = 'bridge-client-below-panel-and-pages';
const UI_BELOW = 'ui-kit-below-panel-and-pages';
const KIT_BELOW = 'test-kit-is-below';
const PAGES_APP = 'pages-are-an-app';
const NO_NODE = 'browser-no-node';
const FROM_ADAPTERS = 'only-adapters-run-programs-or-network';
const FROM_ADAPTERS_HTTP = `${FROM_ADAPTERS}-http`;
const HEALTH_ONLY = 'health-check-is-the-doctors';
const NO_ROUTES = 'cli-and-core-have-no-route-table';
const APPS_NOT_ADAPTERS = 'apps-use-core-not-adapters';

// the packages the matrix crosses: each one's folder, and a `leaf.ts` in it for the others to import
const PACKAGES: Record<string, string> = {
  server: 'server/src',
  web: 'web/public',
  extension: 'extension/src',
  panel: 'panel/src',
  'github-page': 'github-page/src',
  'bridge-client': 'bridge-client/src',
  'ui-kit': 'ui-kit/src',
  contracts: 'contracts/src',
  domain: 'domain/src',
  'test-kit': 'test-kit/src',
};

// [importer][imported]: the rules that must fire. A cell left out is an allowed import (the package's own files included).
const MATRIX: Record<string, Record<string, string[]>> = {
  server: {
    web: [PAGES_APP],
    extension: [EXT_APP],
    panel: [NOT_CLIENT],
    'github-page': [NOT_CLIENT],
    'bridge-client': [NOT_CLIENT],
    'ui-kit': [NOT_CLIENT],
    'test-kit': [SHIPPED],
  },
  web: {
    server: [SERVER_ONLY, 'pages-not-the-extension'],
    extension: ['pages-not-the-extension', EXT_APP],
    'test-kit': [SHIPPED],
  },
  extension: {
    server: [SERVER_ONLY, 'extension-not-the-server'],
    web: ['extension-not-the-server'],
    'test-kit': [SHIPPED],
  },
  panel: {
    server: [SERVER_ONLY, HOST_FREE],
    web: [HOST_FREE],
    extension: [HOST_FREE, EXT_APP],
    'github-page': [HOST_FREE],
    'test-kit': [HOST_FREE, SHIPPED],
  },
  'github-page': {
    server: [SERVER_ONLY, 'github-page-below-apps'],
    web: ['github-page-below-apps', PAGES_APP],
    extension: ['github-page-below-apps', EXT_APP],
    panel: ['github-page-implements-the-panel-port'],
    'test-kit': ['github-page-below-apps', SHIPPED],
  },
  'bridge-client': {
    server: [SERVER_ONLY, CLIENT_BELOW],
    web: [CLIENT_BELOW],
    extension: [CLIENT_BELOW, EXT_APP],
    panel: [CLIENT_BELOW],
    'github-page': [CLIENT_BELOW],
    'ui-kit': [CLIENT_BELOW],
    'test-kit': [CLIENT_BELOW, SHIPPED],
  },
  'ui-kit': {
    server: [SERVER_ONLY, UI_BELOW],
    web: [UI_BELOW],
    extension: [UI_BELOW, EXT_APP],
    panel: [UI_BELOW],
    'github-page': [UI_BELOW],
    'bridge-client': [UI_BELOW],
    'test-kit': [UI_BELOW, SHIPPED],
  },
  contracts: {
    server: [SERVER_ONLY, 'contracts-is-bottom'],
    web: ['contracts-is-bottom', PAGES_APP],
    extension: ['contracts-is-bottom', EXT_APP],
    panel: ['contracts-is-bottom'],
    'github-page': ['contracts-is-bottom'],
    'bridge-client': ['contracts-is-bottom'],
    'ui-kit': ['contracts-is-bottom'],
    'test-kit': ['contracts-is-bottom', SHIPPED],
  },
  domain: Object.fromEntries(
    Object.keys(PACKAGES).map((imported) => [
      imported,
      [
        'domain-imports-nothing',
        ...(imported === 'server' ? [SERVER_ONLY] : []),
        ...(imported === 'extension' ? [EXT_APP] : []),
        ...(imported === 'test-kit' ? [SHIPPED] : []),
      ],
    ]),
  ),
  'test-kit': {
    server: [SERVER_ONLY, KIT_BELOW],
    web: [KIT_BELOW, PAGES_APP],
    extension: [KIT_BELOW, EXT_APP],
    panel: [KIT_BELOW],
    'github-page': [KIT_BELOW],
    'bridge-client': [KIT_BELOW],
    'ui-kit': [KIT_BELOW],
    contracts: [KIT_BELOW],
    domain: [KIT_BELOW],
  },
};
const MATRIX_PROBES: Probe[] = Object.keys(PACKAGES).flatMap((from) =>
  Object.keys(PACKAGES).map((imported): Probe => [
    `${PACKAGES[from]}/to-${imported}.ts`,
    `${PACKAGES[imported]}/leaf.ts`,
    MATRIX[from]?.[imported] ?? null,
  ]),
);

const PROBES: Probe[] = [
  // --- core: the tiers, adapters and the two apps ---
  ...BELOW_RULES.map((rule, i): Probe => [
    `${TIER_FOLDERS[i]}/up.ts`,
    `${TIER_FOLDERS[i + 1]}/leaf.ts`,
    rule,
  ]),
  // a tier may import every tier under it, and an adapter, but never a folder of its own tier
  [`${RECORDS_A}/side.ts`, `${RECORDS_B}/leaf.ts`, 'core-tier-siblings-apart'],
  [`${QUEUES_A}/side.ts`, `${QUEUES_B}/leaf.ts`, 'core-tier-siblings-apart'],
  [`${FEATURES_A}/side.ts`, `${FEATURES_B}/leaf.ts`, 'core-tier-siblings-apart'],
  [`${ORCHESTRATION_A}/side.ts`, `${ORCHESTRATION_B}/leaf.ts`, 'core-tier-siblings-apart'],
  [`${RECORDS_A}/ok-self.ts`, `${RECORDS_A}/leaf.ts`, null],
  [`${RECORDS_A}/ok-down.ts`, `${FOUNDATION}/leaf.ts`, null],
  [`${RECORDS_A}/ok-adapter.ts`, 'core/src/adapters/leaf.ts', null],
  [`${QUEUES_A}/ok-down.ts`, `${RECORDS_A}/leaf.ts`, null],
  [`${FEATURES_A}/ok-down.ts`, `${QUEUES_A}/leaf.ts`, null],
  [`${ORCHESTRATION_A}/ok-down.ts`, `${RECORDS_A}/leaf.ts`, null],
  [`${ORCHESTRATION_B}/ok-down.ts`, `${QUEUES_B}/leaf.ts`, null],
  [`${FOUNDATION}/ok-sibling.ts`, `${FOUNDATION}/leaf.ts`, null], // the bottom tier is files that may import each other
  [`core/src/adapters/up.ts`, `${RECORDS_A}/leaf.ts`, 'adapters-are-bottom'],
  [`core/src/adapters/app.ts`, 'server/src/leaf.ts', ['adapters-are-bottom', 'core-below-apps']],
  [`core/src/adapters/cli.ts`, 'cli/src/leaf.ts', ['adapters-are-bottom', 'core-below-apps']],
  [`${ORCHESTRATION_B}/app.ts`, 'cli/src/leaf.ts', 'core-below-apps'],
  [`${RECORDS_B}/shell.ts`, 'bridge/bin/leaf.ts', 'core-below-apps'],
  ['server/src/adapter.ts', 'core/src/adapters/leaf.ts', 'apps-use-core-not-adapters'],
  ['cli/src/adapter.ts', 'core/src/adapters/leaf.ts', 'apps-use-core-not-adapters'],
  ['server/src/ok-tier.ts', `${RECORDS_A}/leaf.ts`, null],
  ['cli/src/ok-tier.ts', `${ORCHESTRATION_A}/leaf.ts`, null],
  ['server/src/cli.ts', 'cli/src/leaf.ts', 'http-cli-apart'],
  ['cli/src/server.ts', 'server/src/leaf.ts', 'cli-not-http'],
  ['server/src/shell.ts', 'bridge/bin/leaf.ts', 'apps-not-the-shell'],
  ['cli/src/shell.ts', 'bridge/bin/leaf.ts', 'apps-not-the-shell'],
  ['bridge/bin/ok-apps.ts', 'server/src/leaf.ts', null],
  ['bridge/bin/ok-cli.ts', 'cli/src/leaf.ts', null],
  ['bridge/bin/ok-core.ts', `${ORCHESTRATION_A}/leaf.ts`, null],

  // --- only an adapter runs a program or reaches the network ---
  [`${RECORDS_A}/proc.ts`, spec('node:child_process'), FROM_ADAPTERS],
  [`${QUEUES_B}/net.ts`, spec('node:net'), FROM_ADAPTERS],
  [`${ORCHESTRATION_B}/dns.ts`, spec('dns'), FROM_ADAPTERS],
  ['server/src/threads.ts', spec('node:worker_threads'), FROM_ADAPTERS],
  ['server/src/routes/vm.ts', spec('node:vm'), FROM_ADAPTERS],
  ['cli/src/https.ts', spec('node:https'), FROM_ADAPTERS],
  ['core/src/adapters/ok-proc.ts', spec('node:child_process'), null],
  [`${RECORDS_A}/ok-fs.ts`, spec('node:fs'), null],
  [`${RECORDS_A}/http.ts`, spec('node:http'), FROM_ADAPTERS_HTTP],
  [`${FOUNDATION}/http.ts`, spec('node:http'), FROM_ADAPTERS_HTTP],
  ['cli/src/http.ts', spec('node:http'), FROM_ADAPTERS_HTTP],
  ['server/src/routes/http.ts', spec('node:http'), FROM_ADAPTERS_HTTP],
  ['server/src/ok-http.ts', spec('node:http'), null],
  ['core/src/adapters/ok-http.ts', spec('node:http'), null],
  ['server/src/ok-fs.ts', spec('node:fs'), null],

  // --- the CLI never calls the server: the health check is the doctor's, and the route table is not the CLI's or core's ---
  [`${QUEUES_A}/health.ts`, 'core/src/adapters/bridge-health.ts', HEALTH_ONLY],
  [`${ORCHESTRATION_B}/health-too.ts`, 'core/src/adapters/bridge-health.ts', HEALTH_ONLY],
  ['server/src/health.ts', 'core/src/adapters/bridge-health.ts', [HEALTH_ONLY, APPS_NOT_ADAPTERS]],
  ['cli/src/health.ts', 'core/src/adapters/bridge-health.ts', [HEALTH_ONLY, APPS_NOT_ADAPTERS]],
  ['bridge/bin/health.ts', 'core/src/adapters/bridge-health.ts', HEALTH_ONLY],
  [`${ORCHESTRATION_B}/doctor.ts`, 'core/src/adapters/bridge-health.ts', null],
  ['cli/src/to-routes.ts', 'contracts/src/routes.ts', NO_ROUTES],
  ['cli/src/to-route-kit.ts', 'contracts/src/route-kit.ts', NO_ROUTES],
  [`${RECORDS_A}/to-area-routes.ts`, 'contracts/src/story/routes.ts', NO_ROUTES],
  [`${FOUNDATION}/to-routes.ts`, 'contracts/src/routes.ts', NO_ROUTES],
  [`${RECORDS_A}/ok-route-type.ts`, 'contracts/src/routes.ts', null, 'type'],
  ['cli/src/ok-contracts-types.ts', 'contracts/src/types.ts', null],
  ['cli/src/ok-contracts-files.ts', 'contracts/src/files/schemas.ts', null],
  ['server/src/ok-routes.ts', 'contracts/src/routes.ts', null],

  // --- instrumentation is for the shims ---
  [
    `${RECORDS_A}/instr.ts`,
    'bridge/instrumentation/leaf.ts',
    ['instrumentation-is-for-the-shims', 'core-below-apps'],
  ],
  [
    'server/src/instr.ts',
    'bridge/instrumentation/leaf.ts',
    ['instrumentation-is-for-the-shims', 'apps-not-the-shell'],
  ],
  [
    'cli/src/instr.ts',
    'bridge/instrumentation/leaf.ts',
    ['instrumentation-is-for-the-shims', 'apps-not-the-shell'],
  ],
  ['bridge/bin/ok-instr.ts', 'bridge/instrumentation/leaf.ts', null],
  ['bridge/instrumentation/ok-adapter.ts', 'core/src/adapters/leaf.ts', null],

  // --- the bridge serves the client packages, and only the server imports the bridge ---
  [`${RECORDS_A}/client.ts`, 'panel/src/leaf.ts', NOT_CLIENT],
  [`${FOUNDATION}/client.ts`, 'github-page/src/leaf.ts', NOT_CLIENT],
  ['cli/src/client.ts', 'bridge-client/src/leaf.ts', NOT_CLIENT],
  ['bridge/bin/client.ts', 'ui-kit/src/leaf.ts', NOT_CLIENT],
  [`${RECORDS_A}/ok-contracts.ts`, 'contracts/src/leaf.ts', null],
  ['cli/src/ok-domain.ts', 'domain/src/leaf.ts', null],
  ['web/public/to-core.ts', `${FOUNDATION}/leaf.ts`, [SERVER_ONLY, 'pages-not-the-extension']],
  ['web/public/to-cli.ts', 'cli/src/leaf.ts', [SERVER_ONLY, 'pages-not-the-extension']],
  ['web/public/to-shell.ts', 'bridge/bin/leaf.ts', [SERVER_ONLY, 'pages-not-the-extension']],
  ['extension/src/to-core.ts', `${FOUNDATION}/leaf.ts`, [SERVER_ONLY, 'extension-not-the-server']],
  ['test-kit/src/to-core.ts', `${FOUNDATION}/leaf.ts`, [SERVER_ONLY, KIT_BELOW]],

  // --- the pages and the extension are apps: nothing imports them ---
  [`${RECORDS_A}/to-web.ts`, 'web/public/leaf.ts', PAGES_APP],
  ['cli/src/to-web.ts', 'web/public/leaf.ts', PAGES_APP],
  [`${RECORDS_A}/to-extension.ts`, 'extension/src/leaf.ts', EXT_APP],
  ['bridge/bin/to-extension.ts', 'extension/src/leaf.ts', EXT_APP],
  ['extension/src/ok-self.ts', 'extension/src/leaf.ts', null],

  // --- the test kit is dev only ---
  ['bridge/bin/to-kit.ts', 'test-kit/src/leaf.ts', SHIPPED],
  [`${RECORDS_A}/to-kit.ts`, 'test-kit/src/leaf.ts', SHIPPED],
  ['cli/src/to-kit.ts', 'test-kit/src/leaf.ts', SHIPPED],
  ['bridge/test/ok-kit.ts', 'test-kit/src/leaf.ts', null],

  // --- cycles: a value import around a loop, but not a type ---
  [`${FOUNDATION}/cycle-a.ts`, `${FOUNDATION}/cycle-b.ts`, 'no-circular'],
  [`${FOUNDATION}/cycle-b.ts`, `${FOUNDATION}/cycle-a.ts`, null], // the loop's other half: a cycle is reported once, on a
  [`${FOUNDATION}/type-a.ts`, `${FOUNDATION}/type-b.ts`, null, 'type'],
  [`${FOUNDATION}/type-b.ts`, `${FOUNDATION}/type-a.ts`, null, 'type'],

  // --- regions: the panel's and the board page's ---
  ['panel/src/ask/side.ts', 'panel/src/drafts/leaf.ts', 'panel-regions-apart'],
  ['panel/src/reading/side.ts', 'panel/src/rebuild/leaf.ts', 'panel-regions-apart'],
  ['panel/src/ask/ok-self.ts', 'panel/src/ask/leaf.ts', null],
  ['panel/src/ask/ok-shared.ts', 'panel/src/state/leaf.ts', null],
  ['panel/src/ask/root.ts', 'panel/src/shell/overlay.ts', 'panel-region-not-the-root'],
  ['panel/src/shell/overlay.ts', 'panel/src/ask/leaf.ts', null],
  ['web/public/board/header/side.ts', 'web/public/board/columns/leaf.ts', 'board-regions-apart'],
  ['web/public/board/voice/side.ts', 'web/public/board/backlog/leaf.ts', 'board-regions-apart'],
  ['web/public/board/header/ok-self.ts', 'web/public/board/header/leaf.ts', null],
  ['web/public/board/header/ok-shared.ts', 'web/public/board/shared.ts', null],
  ['web/public/board/worktrees/ok-text.ts', 'web/public/board/worktree-text.ts', null],
  ['web/public/board/header/root.ts', 'web/public/board.ts', 'board-region-not-the-root'],
  ['web/public/board.ts', 'web/public/board/header/leaf.ts', null],
  [
    'web/public/board/shared.ts',
    'web/public/board/header/leaf.ts',
    'board-shared-below-the-regions',
  ],
  ['web/public/board/worktree-text.ts', 'web/public/board.ts', 'board-shared-below-the-regions'],

  // --- what ships to a browser has no Node built-ins ---
  ...[
    'web/public',
    'extension/src',
    'panel/src',
    'github-page/src',
    'bridge-client/src',
    'ui-kit/src',
    'contracts/src',
  ].map((dir): Probe => [`${dir}/node-fs.ts`, spec('node:fs'), NO_NODE]),
  ['domain/src/node-fs.ts', spec('node:fs'), [NO_NODE, 'domain-imports-nothing']],
  ['test-kit/src/ok-fs.ts', spec('node:fs'), null],

  // --- contracts: the bottom, imports valibot and the domain only ---
  ['contracts/src/ok-self.ts', 'contracts/src/leaf.ts', null],
  ['contracts/src/ok-schemas.ts', 'contracts/src/schemas.ts', null],
  ['contracts/src/ok-valibot.ts', spec('valibot'), null],
  ['contracts/src/to-npm.ts', spec('left-pad'), 'contracts-imports-only-valibot'],
  ['contracts/src/to-missing.ts', spec('./missing'), ['contracts-no-unresolved', 'no-unresolved']],
  // by name (a workspace link, as the real packages import each other) is refused for its own files, and allowed for the domain
  [
    'contracts/src/to-self-name.ts',
    spec('@once-upon-a-diff/contracts/leaf'),
    'contracts-names-itself-by-path',
  ],
  ['contracts/src/ok-domain-name.ts', spec('@once-upon-a-diff/domain/leaf'), null],
  [
    'contracts/src/to-self-url.ts',
    spec('/assets/contracts/leaf.ts'),
    'contracts-names-no-page-urls',
  ],
  [
    'contracts/src/to-domain-url.ts',
    spec('/assets/domain/leaf.ts'),
    'contracts-names-no-page-urls',
  ],

  // --- the domain imports nothing ---
  ['domain/src/to-valibot.ts', spec('valibot'), 'domain-imports-nothing'],
  ['domain/src/to-missing.ts', spec('./missing'), ['domain-imports-nothing', 'no-unresolved']],

  // --- ui-kit: the contracts, the domain and the vendored Preact, nothing from npm ---
  ['ui-kit/src/to-npm.ts', spec('left-pad'), 'ui-kit-imports-only-the-contracts'],
  ['ui-kit/src/to-valibot.ts', spec('valibot'), 'ui-kit-imports-only-the-contracts'],
  ['ui-kit/src/to-missing.ts', spec('./missing'), ['ui-kit-no-unresolved', 'no-unresolved']],

  // --- an import that resolves to nothing ---
  ['server/src/to-missing.ts', spec('./missing'), 'no-unresolved'],
  ['server/src/to-no-package.ts', spec('no-such-package'), 'no-unresolved'],
  ['web/public/to-missing-url.ts', spec('/assets/missing.ts'), 'no-unresolved'],
  ['web/public/to-vendor-url.ts', spec('/assets/vendor/preact.mjs'), 'no-unresolved'],
  ['web/public/ok-panel-url.ts', spec('/assets/panel/leaf.ts'), null],

  // --- the poll hook is the pages', the poll is shared ---
  ['panel/src/hook.ts', 'bridge-client/src/use-poll.ts', 'poll-hook-is-the-pages'],
  ['extension/src/hook.ts', 'bridge-client/src/use-poll.ts', 'poll-hook-is-the-pages'],
  ['github-page/src/hook.ts', 'bridge-client/src/use-poll.ts', 'poll-hook-is-the-pages'],
  ['web/public/ok-hook.ts', 'bridge-client/src/use-poll.ts', null],
  ['panel/src/ok-poll.ts', 'bridge-client/src/poll.ts', null],
  ['extension/src/ok-poll.ts', 'bridge-client/src/poll.ts', null],

  // --- the host adapter implements the panel's port, and only that ---
  ['github-page/src/ok-host.ts', 'panel/src/host/host.ts', null],
  ['github-page/src/ok-diff-types.ts', 'panel/src/host/diff-types.ts', null],
  [
    'github-page/src/to-context.ts',
    'panel/src/host/context.ts',
    'github-page-implements-the-panel-port',
  ],
  [
    'github-page/src/to-overlay.ts',
    'panel/src/shell/overlay.ts',
    'github-page-implements-the-panel-port',
  ],
  [
    'github-page/src/to-region.ts',
    'panel/src/ask/leaf.ts',
    'github-page-implements-the-panel-port',
  ],

  // --- the schema files are the server's and the contracts package's ---
  ...[
    'web/public',
    'extension/src',
    'panel/src',
    'github-page/src',
    'bridge-client/src',
    'ui-kit/src',
  ].map((dir): Probe => [
    `${dir}/to-schemas.ts`,
    'contracts/src/schemas.ts',
    'schemas-are-server-side',
  ]),
  ['web/public/to-schema-kit.ts', 'contracts/src/schema-kit.ts', 'schemas-are-server-side'],
  ['web/public/to-area-schemas.ts', 'contracts/src/review/schemas.ts', 'schemas-are-server-side'],
  ['web/public/ok-types.ts', 'contracts/src/types.ts', null],
  ['server/src/ok-schemas.ts', 'contracts/src/schemas.ts', null],
  ['server/src/ok-area-schemas.ts', 'contracts/src/review/schemas.ts', null],

  // --- the vendored Preact is named by its URL, and the page URLs stay out of the shared code ---
  ...['panel/src', 'ui-kit/src', 'bridge-client/src', 'extension/src'].map((dir): Probe => [
    `${dir}/to-preact-path.ts`,
    'web/public/vendor/preact.mjs',
    'preact-by-its-url-only',
  ]),
  ...['panel/src', 'ui-kit/src', 'extension/src'].map((dir): Probe => [
    `${dir}/to-preact-url.ts`,
    spec('/assets/preact.mjs'),
    null,
  ]),
  ['bridge-client/src/use-poll.ts', spec('/assets/preact.mjs'), null],
  ['bridge-client/src/to-preact-url.ts', spec('/assets/preact.mjs'), 'no-page-urls-at-all'],
  ['bridge-client/src/to-page-url.ts', spec('/assets/domain/leaf.ts'), 'no-page-urls-at-all'],
  ['github-page/src/to-page-url.ts', spec('/assets/domain/leaf.ts'), 'no-page-urls-at-all'],
  [
    'github-page/src/to-preact-url.ts',
    spec('/assets/preact.mjs'),
    ['no-page-urls-at-all', 'github-page-below-apps', PAGES_APP],
  ],
  [
    'panel/src/to-page-url.ts',
    spec('/assets/domain/leaf.ts'),
    'client-names-packages-not-page-urls',
  ],
  [
    'ui-kit/src/to-page-url.ts',
    spec('/assets/contracts/leaf.ts'),
    'client-names-packages-not-page-urls',
  ],
  [
    'bridge-client/src/use-poll.ts',
    spec('/assets/domain/leaf.ts'),
    'client-names-packages-not-page-urls',
  ],
  ['extension/src/ok-page-url.ts', spec('/assets/domain/leaf.ts'), null],

  ...MATRIX_PROBES,
];

const rulesOf = (rule: string | string[] | null) => [rule ?? []].flat();
const writeSource = (file: string, source: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, source);
};

test('each rule in the dependency-cruiser config fires on its probe, and on nothing else', async () => {
  const dir = tmp('layer-rules');
  const packages = path.join(dir, 'packages');
  // an npm package the probes import, and the one a rule lets through
  for (const name of ['valibot', 'left-pad']) {
    writeSource(
      path.join(dir, 'node_modules', name, 'package.json'),
      `{"name":"${name}","main":"index.js"}\n`,
    );
    writeSource(path.join(dir, 'node_modules', name, 'index.js'), 'exports.leaf = 1;\n');
  }
  // the workspace links by which the real packages name each other
  for (const name of ['contracts', 'domain']) {
    writeSource(
      path.join(packages, name, 'package.json'),
      `{"name":"@once-upon-a-diff/${name}","exports":{"./*":"./src/*.ts"}}\n`,
    );
    mkdirSync(path.join(dir, 'node_modules/@once-upon-a-diff'), { recursive: true });
    symlinkSync(
      path.join('../../packages', name),
      path.join(dir, 'node_modules/@once-upon-a-diff', name),
    );
  }
  // a leaf for every file a probe imports, unless it is a probe itself
  const probeFiles = new Set(PROBES.map(([file]) => file));
  const leaves = PROBES.flatMap(([, target]) => (typeof target === 'string' ? [target] : []));
  for (const leaf of new Set([
    ...leaves,
    ...Object.values(PACKAGES).map((folder) => `${folder}/leaf.ts`),
    'web/public/vendor/preact.mjs',
  ])) {
    if (!probeFiles.has(leaf)) {
      writeSource(path.join(packages, leaf), 'export const leaf = 1;\n');
    }
  }
  // one file per probe file, one import per probe in it
  const imports = new Map<string, string[]>();
  for (const [file, target, , kind] of PROBES) {
    const from = path.join(packages, path.dirname(file));
    const rel =
      typeof target === 'string'
        ? path.relative(from, path.join(packages, target)).split(path.sep).join('/')
        : target.spec;
    const specifier = typeof target === 'string' && !rel.startsWith('.') ? `./${rel}` : rel;
    const line = `import${kind === 'type' ? ' type' : ''} { leaf as one${imports.get(file)?.length ?? 0} } from '${specifier}';\n`;
    imports.set(file, [...(imports.get(file) ?? []), line]);
  }
  for (const [file, lines] of imports) {
    assert.ok(!existsSync(path.join(packages, file)) || probeFiles.has(file));
    writeSource(path.join(packages, file), `${lines.join('')}export const used = 1;\n`);
  }
  const stdout = await new Promise<string>((resolve) => {
    execFile(
      process.execPath,
      [DEPCRUISE, '--config', CONFIG, '--output-type', 'json', 'packages'],
      { cwd: dir, maxBuffer: 1 << 26 },
      (_err, out) => resolve(out),
    );
  });
  const violations = (
    JSON.parse(stdout) as {
      summary: { violations: { from: string; to: string; rule: { name: string } }[] };
    }
  ).summary.violations;
  const found = violations.map((one) => `${one.from} ${one.rule.name}`).sort();
  const expected = PROBES.flatMap(([file, , rule]) =>
    rulesOf(rule).map((name) => `packages/${file} ${name}`),
  ).sort();
  const count = (list: string[], one: string) => list.filter((item) => item === one).length;
  assert.deepEqual(
    {
      'probes that did not trip their rule': expected.filter(
        (one) => count(found, one) < count(expected, one),
      ),
      'violations no probe expects': found.filter(
        (one) => count(expected, one) < count(found, one),
      ),
    },
    { 'probes that did not trip their rule': [], 'violations no probe expects': [] },
  );
});

test('every rule in the dependency-cruiser config has a probe, and every probe names a rule', async () => {
  const config = (await import(pathToFileURL(CONFIG).href)) as {
    default: { forbidden: { name: string }[] };
  };
  const rules = config.default.forbidden.map((one) => one.name);
  const probed = new Set(PROBES.flatMap(([, , rule]) => rulesOf(rule)));
  assert.deepEqual(
    rules.filter((name) => !probed.has(name)),
    [],
    'a rule with no probe in layer-rules.test.ts: add a forbidden import that must trip it (and the allowed one beside it)',
  );
  assert.deepEqual(
    [...probed].filter((name) => !rules.includes(name)),
    [],
    'a probe names a rule the config does not have',
  );
});
