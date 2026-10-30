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
