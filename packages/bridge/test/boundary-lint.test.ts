/*
 * Probes for the package-boundary lint (eslint.boundaries.mjs). Each case lints a snippet as if it
 * sat in a given folder and checks which boundary rule fires, so a rule that stops matching, or a
 * layer that gets a rule replaced by a later block, fails here instead of going quiet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BOUNDARY_RULES = new Set([
  'import/no-restricted-paths',
  'no-restricted-imports',
  'no-restricted-syntax',
  'import/no-nodejs-modules',
]);

const eslint = new ESLint({ cwd: ROOT });

const boundaryRules = async (filePath: string, code: string): Promise<string[]> => {
  const [result] = await eslint.lintText(code, { filePath: `${ROOT}${filePath}` });
  const rules = result.messages.flatMap((message) =>
    message.ruleId && BOUNDARY_RULES.has(message.ruleId) ? [message.ruleId] : [],
  );
  return [...new Set(rules)].sort();
};

const PATHS = 'import/no-restricted-paths';
const IMPORTS = 'no-restricted-imports';
const SYNTAX = 'no-restricted-syntax';
const BUILTINS = 'import/no-nodejs-modules';

// [name, file the snippet pretends to be, snippet, the boundary rules that must fire]
const CASES: [string, string, string, string[]][] = [
  // the server
  [
    'server imports a page',
    'packages/bridge/src/probe.ts',
    `import { splitRows } from '../public/split.ts';`,
    [PATHS],
  ],
  [
    'server imports the extension by path',
    'packages/bridge/src/probe.ts',
    `import { isPageLink } from '../../extension/src/page-links.ts';`,
    [PATHS],
  ],
  [
    'server imports the extension by name',
    'packages/bridge/src/probe.ts',
    `import { x } from '@once-upon-a-diff/extension/settings';`,
    [IMPORTS],
  ],
  [
    'server imports the extension dynamically',
    'packages/bridge/src/probe.ts',
    `await import('@once-upon-a-diff/extension/settings');`,
    [SYNTAX],
  ],
  [
    'server may import shared and Node built-ins',
    'packages/bridge/src/probe.ts',
    `import fs from 'node:fs';\nimport { plural } from '@once-upon-a-diff/shared/util/text';`,
    [],
  ],
  // the pages
  [
    'page imports the server by path',
    'packages/bridge/public/probe.ts',
    `import type { Call } from '../src/types.ts';`,
    [PATHS],
  ],
  [
    'page imports the server by name',
    'packages/bridge/public/probe.ts',
    `import { x } from 'once-upon-a-diff/types';`,
    [IMPORTS],
  ],
  [
    'page imports the server dynamically',
    'packages/bridge/public/probe.ts',
    `await import('once-upon-a-diff/server/assets');`,
    [SYNTAX],
  ],
  [
    'page imports the server in a type',
    'packages/bridge/public/probe.ts',
    `export type Call = import('once-upon-a-diff/types').Call;`,
    [SYNTAX],
  ],
  [
    'page imports a Node built-in',
    'packages/bridge/public/probe.ts',
    `import fs from 'node:fs';`,
    [BUILTINS],
  ],
  [
    'page imports a Node built-in dynamically',
    'packages/bridge/public/probe.ts',
    `await import('node:path');`,
    [BUILTINS],
  ],
  [
    'page may import shared',
    'packages/bridge/public/probe.ts',
    `import { plural } from '@once-upon-a-diff/shared/util/text';`,
    [],
  ],
  // shared
  [
    'shared imports the bridge by path',
    'packages/shared/src/probe.ts',
    `import type { Call } from '../../bridge/src/types.ts';`,
    [PATHS],
  ],
  [
    'shared imports the pages by path',
    'packages/shared/src/panel/probe.ts',
    `import { splitRows } from '../../../bridge/public/split.ts';`,
    [PATHS],
  ],
  [
    'shared imports the extension by path',
    'packages/shared/src/probe.ts',
    `import { isPageLink } from '../../extension/src/page-links.ts';`,
    [PATHS],
  ],
  [
    'shared imports the bridge by name',
    'packages/shared/src/probe.ts',
    `import { x } from 'once-upon-a-diff/types';`,
    [IMPORTS],
  ],
  [
    'shared imports the bridge dynamically',
    'packages/shared/src/probe.ts',
    `await import('once-upon-a-diff/types');`,
    [SYNTAX],
  ],
  [
    'shared imports the pages through /assets/',
    'packages/shared/src/probe.ts',
    `import { x } from '/assets/local/menu.ts';`,
    [IMPORTS],
  ],
  [
    'shared imports itself by name',
    'packages/shared/src/panel/probe.ts',
    `import { x } from '@once-upon-a-diff/shared/panel/body';`,
    [IMPORTS],
  ],
  [
    'shared panel imports a Node built-in',
    'packages/shared/src/panel/probe.ts',
    `import os from 'node:os';`,
    [BUILTINS],
  ],
  [
    'shared imports a bare Node built-in',
    'packages/shared/src/probe.ts',
    `import path from 'path';`,
    [BUILTINS],
  ],
  [
    'shared types import the bridge by path',
    'packages/shared/types/probe.d.ts',
    `import type { Call } from '../../bridge/src/types.ts';`,
    [PATHS],
  ],
  [
    'shared types import the bridge by name',
    'packages/shared/types/probe.d.ts',
    `export type Call = import('once-upon-a-diff/types').Call;`,
    [SYNTAX],
  ],
  [
    'shared panel may import util',
    'packages/shared/src/panel/probe.ts',
    `import { plural } from '../util/text.ts';`,
    [],
  ],
  // shared/util sits below shared/panel, and keeps all of shared's rules
  [
    'util imports the panel by path',
    'packages/shared/src/util/probe.ts',
    `import { x } from '../panel/body.ts';`,
    [PATHS],
  ],
  [
    'util imports the panel by name',
    'packages/shared/src/util/probe.ts',
    `import { x } from '@once-upon-a-diff/shared/panel/body';`,
    [IMPORTS],
  ],
  [
    'util imports the bridge by path',
    'packages/shared/src/util/probe.ts',
    `import type { Call } from '../../../bridge/src/types.ts';`,
    [PATHS],
  ],
  [
    'util imports a Node built-in',
    'packages/shared/src/util/probe.ts',
    `import fs from 'node:fs';`,
    [BUILTINS],
  ],
  [
    'util imports the bridge dynamically',
    'packages/shared/src/util/probe.ts',
    `await import('once-upon-a-diff/types');`,
    [SYNTAX],
  ],
  // the extension
  [
    'extension imports the server by path',
    'packages/extension/src/content/probe.ts',
    `import type { Call } from '../../../bridge/src/types.ts';`,
    [PATHS],
  ],
  [
    'extension imports the server by name',
    'packages/extension/src/probe.ts',
    `import { x } from 'once-upon-a-diff/types';`,
    [IMPORTS],
  ],
  [
    'extension imports the server dynamically',
    'packages/extension/src/probe.ts',
    `await import('once-upon-a-diff/server/assets');`,
    [SYNTAX],
  ],
  [
    'extension imports a Node built-in',
    'packages/extension/src/probe.ts',
    `import fs from 'node:fs';`,
    [BUILTINS],
  ],
  [
    'extension may import shared',
    'packages/extension/src/probe.ts',
    `import { plural } from '@once-upon-a-diff/shared/util/text';`,
    [],
  ],
  // the protocol: no DOM, no Node, no package but valibot, and nothing above it
  [
    'protocol imports the bridge by path',
    'packages/protocol/src/probe.ts',
    `import type { Call } from '../../bridge/src/types.ts';`,
    [PATHS],
  ],
  [
    'protocol imports shared by path',
    'packages/protocol/src/probe.ts',
    `import { plural } from '../../shared/src/util/text.ts';`,
    [PATHS],
  ],
  [
    'protocol imports the extension by path',
    'packages/protocol/src/probe.ts',
    `import { isPageLink } from '../../extension/src/page-links.ts';`,
    [PATHS],
  ],
  [
    'protocol imports shared by name',
    'packages/protocol/src/probe.ts',
    `import { plural } from '@once-upon-a-diff/shared/util/text';`,
    [IMPORTS],
  ],
  [
    'protocol imports the bridge by name',
    'packages/protocol/src/probe.ts',
    `import { x } from 'once-upon-a-diff/types';`,
    [IMPORTS],
  ],
  [
    'protocol imports another package',
    'packages/protocol/src/probe.ts',
    `import { x } from 'zod';`,
    [IMPORTS],
  ],
  [
    'protocol imports another package dynamically',
    'packages/protocol/src/probe.ts',
    `await import('zod');`,
    [SYNTAX],
  ],
  [
    'protocol imports another package in a type',
    'packages/protocol/src/probe.ts',
    `export type X = import('@once-upon-a-diff/shared/types').StoryData;`,
    [SYNTAX],
  ],
  [
    'protocol imports through /assets/',
    'packages/protocol/src/probe.ts',
    `import { x } from '/assets/local/menu.ts';`,
    [IMPORTS],
  ],
  [
    'protocol imports a Node built-in',
    'packages/protocol/src/probe.ts',
    `import fs from 'node:fs';`,
    [BUILTINS, IMPORTS],
  ],
  [
    'protocol imports a bare Node built-in',
    'packages/protocol/src/probe.ts',
    `import path from 'path';`,
    [BUILTINS, IMPORTS],
  ],
  [
    'protocol may import valibot, itself and its domain',
    'packages/protocol/src/probe.ts',
    `import { object } from 'valibot';\nimport type { Prefs } from './types.ts';\nimport { SESSION_RE } from './domain/patterns.ts';`,
    [],
  ],
  // the domain imports nothing
  [
    'domain imports the rest of the protocol',
    'packages/protocol/src/domain/probe.ts',
    `import type { Prefs } from '../types.ts';`,
    [IMPORTS, PATHS],
  ],
  [
    'domain imports a sibling',
    'packages/protocol/src/domain/probe.ts',
    `import { SESSION_RE } from './patterns.ts';`,
    [IMPORTS, PATHS],
  ],
  [
    'domain imports valibot',
    'packages/protocol/src/domain/probe.ts',
    `import { object } from 'valibot';`,
    [IMPORTS],
  ],
  [
    'domain imports a Node built-in',
    'packages/protocol/src/domain/probe.ts',
    `import fs from 'node:fs';`,
    [BUILTINS, IMPORTS],
  ],
  [
    'domain imports dynamically',
    'packages/protocol/src/domain/probe.ts',
    `await import('../types.ts');`,
    [PATHS, SYNTAX],
  ],
  [
    'domain re-exports from another module',
    'packages/protocol/src/domain/probe.ts',
    `export { REPO_RE } from './patterns.ts';`,
    [IMPORTS, PATHS],
  ],
  [
    'domain with no imports is fine',
    'packages/protocol/src/domain/probe.ts',
    `export const ID_RE = /^[a-z]+$/;`,
    [],
  ],
  // the schemas are server side: nothing that ships to a browser imports them
  [
    'a page imports the schemas by name',
    'packages/bridge/public/probe.ts',
    `import { BODIES } from '@once-upon-a-diff/protocol/schemas';`,
    [IMPORTS],
  ],
  [
    'a page imports the schemas through /assets/',
    'packages/bridge/public/probe.ts',
    `import { BODIES } from '/assets/protocol/schemas.ts';`,
    [IMPORTS],
  ],
  [
    'a page imports the schemas dynamically',
    'packages/bridge/public/local/probe.ts',
    `await import('/assets/protocol/schemas.ts');`,
    [SYNTAX],
  ],
  [
    'a page imports the schemas by path',
    'packages/bridge/public/probe.ts',
    `import { BODIES } from '../../protocol/src/schemas.ts';`,
    [PATHS],
  ],
  [
    'the extension imports the schemas by name',
    'packages/extension/src/probe.ts',
    `import { BODIES } from '@once-upon-a-diff/protocol/schemas';`,
    [IMPORTS],
  ],
  [
    'the extension imports the schemas by path',
    'packages/extension/src/content/probe.ts',
    `import { BODIES } from '../../../protocol/src/schemas.ts';`,
    [PATHS],
  ],
  [
    'shared imports the schemas by name',
    'packages/shared/src/panel/probe.ts',
    `import { BODIES } from '@once-upon-a-diff/protocol/schemas';`,
    [IMPORTS],
  ],
  [
    'shared util imports the schemas by path',
    'packages/shared/src/util/probe.ts',
    `import { BODIES } from '../../../protocol/src/schemas.ts';`,
    [PATHS],
  ],
  [
    'the clients may import the route table and the client',
    'packages/extension/src/probe.ts',
    `import { ROUTES } from '@once-upon-a-diff/protocol/routes';\nimport { createClient } from '@once-upon-a-diff/protocol/client';`,
    [],
  ],
  [
    'a page may import the route table through /assets/',
    'packages/bridge/public/probe.ts',
    `import { ROUTES } from '/assets/protocol/routes.ts';\nimport { createClient } from '/assets/protocol/client.ts';`,
    [],
  ],
  [
    'the server may import the schemas',
    'packages/bridge/src/probe.ts',
    `import { checkBody } from '@once-upon-a-diff/protocol/schemas';`,
    [],
  ],
  // outside every layer
  [
    'tests cross packages freely',
    'packages/extension/test/probe.ts',
    `import { x } from 'once-upon-a-diff/types';\nimport fs from 'node:fs';`,
    [],
  ],
];

for (const [name, filePath, code, expected] of CASES) {
  test(`boundary lint: ${name}`, async () => {
    assert.deepEqual(await boundaryRules(filePath, code), expected.sort());
  });
}
