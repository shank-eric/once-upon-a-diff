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
  'no-restricted-globals',
  'no-restricted-properties',
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
const GLOBALS = 'no-restricted-globals';
const PROPERTIES = 'no-restricted-properties';

// [name, file the snippet pretends to be, snippet, the boundary rules that must fire]
const CASES: [string, string, string, string[]][] = [
  // the server (every layer under packages/bridge/src carries these four)
  [
    'server imports a page',
    'packages/bridge/src/services/probe.ts',
    `import { splitRows } from '../../../web/public/split.ts';`,
    [PATHS],
  ],
  [
    'server imports the extension by path',
    'packages/bridge/src/services/probe.ts',
    `import { isPageLink } from '../../../extension/src/page-links.ts';`,
    [PATHS],
  ],
  [
    'server imports the extension by name',
    'packages/bridge/src/services/probe.ts',
    `import { x } from '@once-upon-a-diff/extension/settings';`,
    [IMPORTS],
  ],
  [
    'server imports the extension dynamically',
    'packages/bridge/src/services/probe.ts',
    `await import('@once-upon-a-diff/extension/settings');`,
    [SYNTAX],
  ],
  [
    'server may import shared and Node built-ins',
    'packages/bridge/src/services/probe.ts',
    `import { readFileSync } from 'node:fs';\nimport { plural } from '@once-upon-a-diff/shared/util/text';`,
    [],
  ],
  // the server's layers: apps (http, cli) over services over adapters
  [
    'a service imports the HTTP app',
    'packages/bridge/src/services/probe.ts',
    `import type { Call } from '../server/types.ts';`,
    [PATHS],
  ],
  [
    'a service imports a route',
    'packages/bridge/src/services/probe.ts',
    `import { boardRoutes } from '../server/routes/board.ts';`,
    [PATHS],
  ],
  [
    'a service imports the CLI',
    'packages/bridge/src/services/probe.ts',
    `import type { Command } from '../cli/types.ts';`,
    [PATHS],
  ],
  [
    'an adapter imports a service',
    'packages/bridge/src/adapters/probe.ts',
    `import { BoardError } from '../services/errors.ts';`,
    [PATHS],
  ],
  [
    'an adapter imports the HTTP app',
    'packages/bridge/src/adapters/probe.ts',
    `import type { Call } from '../server/types.ts';`,
    [PATHS],
  ],
  [
    'a route imports an adapter',
    'packages/bridge/src/server/routes/probe.ts',
    `import { main } from '../../adapters/os.ts';`,
    [PATHS],
  ],
  [
    'the HTTP app imports an adapter',
    'packages/bridge/src/server/probe.ts',
    `import { readJson } from '../adapters/stores/json-file.ts';`,
    [PATHS],
  ],
  [
    'the HTTP app imports the CLI',
    'packages/bridge/src/server/probe.ts',
    `import type { Command } from '../cli/types.ts';`,
    [PATHS],
  ],
  [
    'the CLI imports an adapter',
    'packages/bridge/src/cli/commands/probe.ts',
    `import { topLevel } from '../../adapters/git.ts';`,
    [PATHS],
  ],
  [
    'the CLI imports the HTTP app',
    'packages/bridge/src/cli/probe.ts',
    `import { createBridge } from '../server/index.ts';`,
    [PATHS],
  ],
  [
    'routes and the CLI may import a service',
    'packages/bridge/src/cli/commands/probe.ts',
    `import { readSettings } from '../../services/config/settings.ts';\nimport type { Command } from '../types.ts';`,
    [],
  ],
  [
    'the HTTP app may import a service and its own routes',
    'packages/bridge/src/server/probe.ts',
    `import { readSettings } from '../services/config/settings.ts';\nimport { boardRoutes } from './routes/board.ts';`,
    [],
  ],
  [
    'a service may import an adapter',
    'packages/bridge/src/services/probe.ts',
    `import { runGit } from '../adapters/git.ts';`,
    [],
  ],
  // only an adapter runs a program, writes a file or reaches the network
  [
    'a service runs a program',
    'packages/bridge/src/services/probe.ts',
    `import { execFile } from 'node:child_process';`,
    [IMPORTS],
  ],
  [
    'a service runs a program dynamically',
    'packages/bridge/src/services/probe.ts',
    `await import('node:child_process');`,
    [SYNTAX],
  ],
  [
    'the CLI runs a program',
    'packages/bridge/src/cli/probe.ts',
    `import { execFileSync } from 'child_process';`,
    [IMPORTS],
  ],
  [
    'a route runs a program',
    'packages/bridge/src/server/routes/probe.ts',
    `import { spawn } from 'node:child_process';`,
    [IMPORTS],
  ],
  [
    'a service writes a file',
    'packages/bridge/src/services/probe.ts',
    `import { readFileSync, writeFileSync } from 'node:fs';`,
    [IMPORTS],
  ],
  [
    'a service makes a folder',
    'packages/bridge/src/services/probe.ts',
    `import { mkdir } from 'node:fs/promises';`,
    [IMPORTS],
  ],
  [
    'the CLI appends to a file',
    'packages/bridge/src/cli/probe.ts',
    `import { appendFileSync } from 'fs';`,
    [IMPORTS],
  ],
  [
    'a route removes a file',
    'packages/bridge/src/server/routes/probe.ts',
    `import { rmSync } from 'node:fs';`,
    [IMPORTS],
  ],
  [
    'the HTTP app writes a file',
    'packages/bridge/src/server/probe.ts',
    `import { renameSync } from 'node:fs';`,
    [IMPORTS],
  ],
  [
    'a service imports fs whole, which hides its writes',
    'packages/bridge/src/services/probe.ts',
    `import fs from 'node:fs';`,
    [SYNTAX],
  ],
  [
    'a service imports fs as a namespace',
    'packages/bridge/src/services/probe.ts',
    `import * as fs from 'node:fs/promises';`,
    [IMPORTS, SYNTAX],
  ],
  [
    'a service imports fs dynamically',
    'packages/bridge/src/services/probe.ts',
    `const fs = await import('node:fs');`,
    [SYNTAX],
  ],
  [
    'a service may read files',
    'packages/bridge/src/services/probe.ts',
    `import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';\nimport { readdir, stat } from 'node:fs/promises';`,
    [],
  ],
  [
    'a service opens a socket',
    'packages/bridge/src/services/probe.ts',
    `import net from 'node:net';`,
    [IMPORTS],
  ],
  [
    'a service uses http',
    'packages/bridge/src/services/probe.ts',
    `import type { IncomingMessage } from 'node:http';`,
    [IMPORTS],
  ],
  [
    'a service looks up a host',
    'packages/bridge/src/services/probe.ts',
    `import { lookup } from 'node:dns/promises';`,
    [IMPORTS],
  ],
  [
    'a route uses http',
    'packages/bridge/src/server/routes/probe.ts',
    `import http from 'node:http';`,
    [IMPORTS],
  ],
  [
    'the CLI uses https',
    'packages/bridge/src/cli/probe.ts',
    `import https from 'node:https';`,
    [IMPORTS],
  ],
  [
    'the HTTP app opens a socket',
    'packages/bridge/src/server/probe.ts',
    `import net from 'node:net';`,
    [IMPORTS],
  ],
  [
    'the HTTP app has node:http, to listen',
    'packages/bridge/src/server/probe.ts',
    `import http, { type IncomingMessage } from 'node:http';`,
    [],
  ],
  [
    'a service calls fetch',
    'packages/bridge/src/services/probe.ts',
    `export const load = () => fetch('http://127.0.0.1:4823/api/health');`,
    [GLOBALS],
  ],
  [
    'the CLI calls fetch',
    'packages/bridge/src/cli/probe.ts',
    `export const load = () => fetch('http://127.0.0.1:4823/api/health');`,
    [GLOBALS],
  ],
  [
    'a service imports the fs promises object',
    'packages/bridge/src/services/probe.ts',
    `import { promises } from 'node:fs';\nexport const save = () => promises.writeFile('a', 'b');`,
    [IMPORTS],
  ],
  [
    'a service aliases the fs promises object',
    'packages/bridge/src/services/probe.ts',
    `import { promises as fsp } from 'fs';`,
    [IMPORTS],
  ],
  [
    'a service writes through fs/promises write',
    'packages/bridge/src/services/probe.ts',
    `import { write } from 'node:fs/promises';`,
    [IMPORTS],
  ],
  [
    'a service writes through async write',
    'packages/bridge/src/services/probe.ts',
    `import { write } from 'node:fs';`,
    [IMPORTS],
  ],
  [
    'a service writes through writev',
    'packages/bridge/src/services/probe.ts',
    `import { writev } from 'node:fs';`,
    [IMPORTS],
  ],
  [
    'a service writes through writevSync',
    'packages/bridge/src/services/probe.ts',
    `import { writevSync } from 'fs';`,
    [IMPORTS],
  ],
  [
    'a service opens a file for writing',
    'packages/bridge/src/services/probe.ts',
    `import { openSync } from 'node:fs';\nexport const f = () => openSync('a', 'w');`,
    [SYNTAX],
  ],
  [
    'a service opens a file for appending, async',
    'packages/bridge/src/services/probe.ts',
    `import { open } from 'node:fs/promises';\nexport const f = () => open('a', 'a');`,
    [SYNTAX],
  ],
  [
    'a service opens a file with a flag it computes',
    'packages/bridge/src/services/probe.ts',
    `import { openSync } from 'node:fs';\nexport const f = (flag: string) => openSync('a', flag);`,
    [SYNTAX],
  ],
  [
    'a service opens a file with no flag named',
    'packages/bridge/src/services/probe.ts',
    `import { open } from 'node:fs/promises';\nexport const f = () => open('a');`,
    [SYNTAX],
  ],
  [
    'a service hides openSync behind an alias',
    'packages/bridge/src/services/probe.ts',
    `import { openSync as o } from 'node:fs';`,
    [SYNTAX],
  ],
  [
    'the CLI opens a file for writing',
    'packages/bridge/src/cli/probe.ts',
    `import { openSync } from 'node:fs';\nexport const f = () => openSync('a', 'w');`,
    [SYNTAX],
  ],
  [
    'a service may open a file to read it',
    'packages/bridge/src/services/probe.ts',
    `import { openSync, readSync, closeSync } from 'node:fs';\nexport const f = () => openSync('a', 'r');`,
    [],
  ],
  [
    'a service loads child_process through createRequire',
    'packages/bridge/src/services/probe.ts',
    `import { createRequire } from 'node:module';\nexport const cp = createRequire(import.meta.url)('node:child_process');`,
    [IMPORTS],
  ],
  [
    'a service imports node:module whole',
    'packages/bridge/src/services/probe.ts',
    `import module from 'node:module';\nexport const cp = module.createRequire(import.meta.url);`,
    [SYNTAX],
  ],
  [
    'a service imports node:module dynamically',
    'packages/bridge/src/services/probe.ts',
    `const { createRequire } = await import('node:module');`,
    [SYNTAX],
  ],
  [
    'the HTTP app may strip type annotations through node:module',
    'packages/bridge/src/server/probe.ts',
    `import { stripTypeScriptTypes } from 'node:module';`,
    [],
  ],
  [
    'a route imports module by its short name',
    'packages/bridge/src/server/routes/probe.ts',
    `import { createRequire } from 'module';`,
    [IMPORTS],
  ],
  [
    'a service starts a worker thread',
    'packages/bridge/src/services/probe.ts',
    `import { Worker } from 'node:worker_threads';`,
    [IMPORTS],
  ],
  [
    'the CLI starts a worker thread',
    'packages/bridge/src/cli/probe.ts',
    `import { Worker } from 'worker_threads';`,
    [IMPORTS],
  ],
  [
    'a service evaluates code with vm',
    'packages/bridge/src/services/probe.ts',
    `import vm from 'node:vm';`,
    [IMPORTS],
  ],
  [
    'a service calls globalThis.fetch',
    'packages/bridge/src/services/probe.ts',
    `export const load = () => globalThis.fetch('http://127.0.0.1:4823/api/health');`,
    [PROPERTIES],
  ],
  [
    'a route calls globalThis.fetch with a computed key',
    'packages/bridge/src/server/routes/probe.ts',
    `export const load = () => globalThis['fetch']('http://127.0.0.1:4823/api/health');`,
    [PROPERTIES],
  ],
  [
    'the HTTP app calls global.fetch',
    'packages/bridge/src/server/probe.ts',
    `export const load = () => global.fetch('http://127.0.0.1:4823/api/health');`,
    [PROPERTIES],
  ],
  [
    'a service pulls fetch out of globalThis',
    'packages/bridge/src/services/probe.ts',
    `const { fetch: f } = globalThis;\nexport const load = () => f('http://127.0.0.1:4823/api/health');`,
    [PROPERTIES],
  ],
  [
    'a service signals a process',
    'packages/bridge/src/services/probe.ts',
    `export const stop = (pid: number) => process.kill(pid, 'SIGTERM');`,
    [PROPERTIES],
  ],
  [
    'the CLI signals a process',
    'packages/bridge/src/cli/probe.ts',
    `export const stop = (pid: number) => process.kill(pid, 0);`,
    [PROPERTIES],
  ],
  [
    'a service pulls kill out of process',
    'packages/bridge/src/services/probe.ts',
    `const { kill } = process;\nexport const stop = (pid: number) => kill(pid, 0);`,
    [PROPERTIES],
  ],
  [
    'a service may read process.env and process.pid',
    'packages/bridge/src/services/probe.ts',
    `export const me = () => [process.pid, process.env.HOME];`,
    [],
  ],
  [
    'an adapter may run programs, write files and reach the network',
    'packages/bridge/src/adapters/probe.ts',
    `import { execFile } from 'node:child_process';\nimport fs, { writeFileSync } from 'node:fs';\nimport net from 'node:net';\nimport http from 'node:http';\nimport { promises, openSync } from 'node:fs';\nimport { createRequire } from 'node:module';\nimport { Worker } from 'node:worker_threads';\nexport const load = () => globalThis.fetch('http://127.0.0.1:4823/api/health');\nexport const stop = (pid: number) => process.kill(pid, 0);\nexport const open = () => openSync('a', 'w');\nexport const fetchIt = () => fetch('http://127.0.0.1:4823/api/health');`,
    [],
  ],
  // the pages
  [
    'page imports the server by path',
    'packages/web/public/probe.ts',
    `import type { Call } from '../../bridge/src/server/types.ts';`,
    [PATHS],
  ],
  [
    'page imports the server by name',
    'packages/web/public/probe.ts',
    `import { x } from 'once-upon-a-diff/types';`,
    [IMPORTS],
  ],
  [
    'page imports the server dynamically',
    'packages/web/public/probe.ts',
    `await import('once-upon-a-diff/server/assets');`,
    [SYNTAX],
  ],
  [
    'page imports the server in a type',
    'packages/web/public/probe.ts',
    `export type Call = import('once-upon-a-diff/types').Call;`,
    [SYNTAX],
  ],
  [
    'page imports a Node built-in',
    'packages/web/public/probe.ts',
    `import fs from 'node:fs';`,
    [BUILTINS],
  ],
  [
    'page imports a Node built-in dynamically',
    'packages/web/public/probe.ts',
    `await import('node:path');`,
    [BUILTINS],
  ],
  [
    'page may import shared',
    'packages/web/public/probe.ts',
    `import { plural } from '@once-upon-a-diff/shared/util/text';`,
    [],
  ],
  // shared
  [
    'shared imports the bridge by path',
    'packages/shared/src/probe.ts',
    `import type { Call } from '../../bridge/src/server/types.ts';`,
    [PATHS],
  ],
  [
    'shared imports the pages by path',
    'packages/shared/src/probe.ts',
    `import { splitRows } from '../../web/public/split.ts';`,
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
    'packages/shared/src/probe.ts',
    `import { x } from '@once-upon-a-diff/shared/util/text';`,
    [IMPORTS],
  ],
  [
    'the panel imports a Node built-in',
    'packages/panel/src/probe.ts',
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
    'panel types import the bridge by path',
    'packages/panel/types/probe.d.ts',
    `import type { Call } from '../../bridge/src/server/types.ts';`,
    [PATHS],
  ],
  [
    'panel types import the bridge by name',
    'packages/panel/types/probe.d.ts',
    `export type Call = import('once-upon-a-diff/types').Call;`,
    [SYNTAX],
  ],
  [
    'the panel may import shared util and the protocol',
    'packages/panel/src/probe.ts',
    `import { plural } from '@once-upon-a-diff/shared/util/text';\nimport { ROUTES } from '@once-upon-a-diff/protocol/routes';\nimport type { StoryData } from '@once-upon-a-diff/protocol/types';`,
    [],
  ],
  // shared/util sits below shared/host, and keeps all of shared's rules
  [
    'util imports the host adapters by path',
    'packages/shared/src/util/probe.ts',
    `import { createHostPage } from '../host/diff-dom.ts';`,
    [PATHS],
  ],
  [
    'util imports the panel by name',
    'packages/shared/src/util/probe.ts',
    `import { x } from '@once-upon-a-diff/panel/body';`,
    [IMPORTS],
  ],
  [
    'util imports the bridge by path',
    'packages/shared/src/util/probe.ts',
    `import type { Call } from '../../../bridge/src/server/types.ts';`,
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
    `import type { Call } from '../../../bridge/src/server/types.ts';`,
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
    `import type { Call } from '../../bridge/src/server/types.ts';`,
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
    'packages/web/public/probe.ts',
    `import { BODIES } from '@once-upon-a-diff/protocol/schemas';`,
    [IMPORTS],
  ],
  [
    'a page imports the schemas through /assets/',
    'packages/web/public/probe.ts',
    `import { BODIES } from '/assets/protocol/schemas.ts';`,
    [IMPORTS],
  ],
  [
    'a page imports the schemas dynamically',
    'packages/web/public/local/probe.ts',
    `await import('/assets/protocol/schemas.ts');`,
    [SYNTAX],
  ],
  [
    'a page imports the schemas by path',
    'packages/web/public/probe.ts',
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
    'packages/web/public/probe.ts',
    `import { ROUTES } from '/assets/protocol/routes.ts';\nimport { createClient } from '/assets/protocol/client.ts';`,
    [],
  ],
  [
    'the server may import the schemas',
    'packages/bridge/src/server/probe.ts',
    `import { checkBody } from '@once-upon-a-diff/protocol/schemas';`,
    [],
  ],
  // the panel: host-agnostic, over the protocol and the shared helpers
  [
    'the panel imports the extension by path',
    'packages/panel/src/probe.ts',
    `import { isPageLink } from '../../extension/src/page-links.ts';`,
    [PATHS],
  ],
  [
    'the panel imports the extension by name',
    'packages/panel/src/probe.ts',
    `import { x } from '@once-upon-a-diff/extension/page-links';`,
    [IMPORTS],
  ],
  [
    'the panel imports the pages by path',
    'packages/panel/src/probe.ts',
    `import { splitRows } from '../../web/public/split.ts';`,
    [PATHS],
  ],
  [
    'the panel imports the pages by name',
    'packages/panel/src/probe.ts',
    `import { x } from '@once-upon-a-diff/web/public/split.ts';`,
    [IMPORTS],
  ],
  [
    'the panel imports the bridge by path',
    'packages/panel/src/probe.ts',
    `import type { Call } from '../../bridge/src/server/types.ts';`,
    [PATHS],
  ],
  [
    'the panel imports the bridge by name',
    'packages/panel/src/probe.ts',
    `import { x } from 'once-upon-a-diff/types';`,
    [IMPORTS],
  ],
  [
    'the panel imports the bridge dynamically',
    'packages/panel/src/probe.ts',
    `await import('once-upon-a-diff/types');`,
    [SYNTAX],
  ],
  [
    'the panel imports a host adapter by path',
    'packages/panel/src/probe.ts',
    `import { createHostPage } from '../../shared/src/host/diff-dom.ts';`,
    [PATHS],
  ],
  [
    'the panel imports a host adapter by name',
    'packages/panel/src/probe.ts',
    `import { createHostPage } from '@once-upon-a-diff/shared/host/diff-dom';`,
    [IMPORTS],
  ],
  [
    'the panel imports a host adapter dynamically',
    'packages/panel/src/probe.ts',
    `await import('@once-upon-a-diff/shared/host/diff-dom');`,
    [SYNTAX],
  ],
  [
    'the panel imports the schemas',
    'packages/panel/src/probe.ts',
    `import { BODIES } from '@once-upon-a-diff/protocol/schemas';`,
    [IMPORTS],
  ],
  // the panel's regions: not each other, not the composition root
  [
    'a panel region imports another region by path',
    'packages/panel/src/ask/probe.ts',
    `import { createDrafts } from '../drafts/drafts.ts';`,
    [PATHS],
  ],
  [
    'a panel region imports another region by name',
    'packages/panel/src/ask/probe.ts',
    `import { createDrafts } from '@once-upon-a-diff/panel/drafts/drafts';`,
    [IMPORTS],
  ],
  [
    'a panel region imports another region dynamically',
    'packages/panel/src/reading/probe.ts',
    `await import('@once-upon-a-diff/panel/fixes/fixes');`,
    [SYNTAX],
  ],
  [
    'a panel region imports the composition root by path',
    'packages/panel/src/fixes/probe.ts',
    `import { storyOverlay } from '../overlay.ts';`,
    [PATHS],
  ],
  [
    'a panel region imports the composition root by name',
    'packages/panel/src/rebuild/probe.ts',
    `import { storyOverlay } from '@once-upon-a-diff/panel/overlay';`,
    [IMPORTS],
  ],
  [
    'a panel region keeps the panel’s rules: no host adapter, no Node built-in',
    'packages/panel/src/drafts/probe.ts',
    `import { createHostPage } from '@once-upon-a-diff/shared/host/diff-dom';\nimport fs from 'node:fs';`,
    [BUILTINS, IMPORTS],
  ],
  [
    'a panel region may import the panel’s shared files, its own folder, shared util and the protocol',
    'packages/panel/src/ask/probe.ts',
    `import type { PanelContext } from '../context.ts';\nimport { draftsOf } from './questions.ts';\nimport { html } from '@once-upon-a-diff/shared/util/html';\nimport { ROUTES } from '@once-upon-a-diff/protocol/routes';`,
    [],
  ],
  [
    'the composition root may import the regions and the shared files',
    'packages/panel/src/overlay.ts',
    `import { createDrafts } from './drafts/drafts.ts';\nimport { createFixes } from './fixes/fixes.ts';\nimport type { PanelHost } from './host.ts';`,
    [],
  ],
  // the host adapters: shared helpers below the apps, handed to the panel
  [
    'a host adapter imports the panel by path',
    'packages/shared/src/host/probe.ts',
    `import type { PanelContext } from '../../../panel/src/context.ts';`,
    [PATHS],
  ],
  [
    'a host adapter imports the panel by name',
    'packages/shared/src/host/probe.ts',
    `import { x } from '@once-upon-a-diff/panel/host';`,
    [IMPORTS],
  ],
  [
    'a host adapter imports the bridge by name',
    'packages/shared/src/host/probe.ts',
    `import { x } from 'once-upon-a-diff/types';`,
    [IMPORTS],
  ],
  [
    'a host adapter may import shared util and is browser code',
    'packages/shared/src/host/probe.ts',
    `import type { FileBlock } from '../util/diff-types.ts';`,
    [],
  ],
  [
    'a host adapter imports a Node built-in',
    'packages/shared/src/host/probe.ts',
    `import os from 'node:os';`,
    [BUILTINS],
  ],
  // the server and the protocol do not reach the client
  [
    'the server imports the panel by path',
    'packages/bridge/src/services/probe.ts',
    `import { chapterKeyOf } from '../../../panel/src/overlay.ts';`,
    [PATHS],
  ],
  [
    'the server imports the panel by name',
    'packages/bridge/src/services/probe.ts',
    `import { chapterKeyOf } from '@once-upon-a-diff/panel/overlay';`,
    [IMPORTS],
  ],
  [
    'the server may import the shared helpers',
    'packages/bridge/src/services/probe.ts',
    `import { chapterKeyOf } from '@once-upon-a-diff/shared/util/story-model';`,
    [],
  ],
  [
    'the protocol imports the panel by path',
    'packages/protocol/src/probe.ts',
    `import { storyOverlay } from '../../panel/src/overlay.ts';`,
    [PATHS],
  ],
  [
    'the protocol imports the pages by path',
    'packages/protocol/src/probe.ts',
    `import { splitRows } from '../../web/public/split.ts';`,
    [PATHS],
  ],
  // the board page's regions
  [
    'a board region imports another region by URL',
    'packages/web/public/board/columns/probe.ts',
    `import { backlogHtml } from '/assets/board/backlog/backlog.ts';`,
    [IMPORTS],
  ],
  [
    'a board region imports another region dynamically',
    'packages/web/public/board/header/probe.ts',
    `await import('/assets/board/worktrees/worktrees.ts');`,
    [SYNTAX],
  ],
  [
    'a board region imports another region by path',
    'packages/web/public/board/voice/probe.ts',
    `import { worktreesHtml } from '../worktrees/worktrees.ts';`,
    [PATHS],
  ],
  [
    'a board region imports the page by URL',
    'packages/web/public/board/backlog/probe.ts',
    `import { x } from '/assets/board.ts';`,
    [IMPORTS],
  ],
  [
    'a board region imports the page by path',
    'packages/web/public/board/backlog/probe.ts',
    `import { x } from '../../board.ts';`,
    [PATHS],
  ],
  [
    'a board region keeps the pages’ rules: no server, no schemas, no Node built-in',
    'packages/web/public/board/worktrees/probe.ts',
    `import { x } from 'once-upon-a-diff/types';\nimport { BODIES } from '/assets/protocol/schemas.ts';\nimport fs from 'node:fs';`,
    [BUILTINS, IMPORTS],
  ],
  [
    'a board region may import board/shared, the page helpers, shared util and the protocol',
    'packages/web/public/board/columns/probe.ts',
    `import { ago } from '/assets/board/shared.ts';\nimport { stored } from '/assets/local/stored.ts';\nimport { html } from '/assets/util/html.ts';\nimport { ROUTES } from '/assets/protocol/routes.ts';\nimport { x } from './columns.ts';`,
    [],
  ],
  [
    'board/shared imports a region by URL',
    'packages/web/public/board/shared.ts',
    `import { cardHtml } from '/assets/board/columns/columns.ts';`,
    [IMPORTS],
  ],
  [
    'board/shared imports a region by path',
    'packages/web/public/board/shared.ts',
    `import { cardHtml } from './columns/columns.ts';`,
    [PATHS],
  ],
  [
    'the board page may import its regions',
    'packages/web/public/board.ts',
    `import { cardHtml } from '/assets/board/columns/columns.ts';\nimport { backlogHtml } from '/assets/board/backlog/backlog.ts';\nimport { ago } from '/assets/board/shared.ts';`,
    [],
  ],
  [
    'the pages may import the panel and the host adapters',
    'packages/web/public/local/probe.ts',
    `import { storyOverlay } from '/assets/panel/overlay.ts';\nimport { createHostPage } from '/assets/host/diff-dom.ts';`,
    [],
  ],
  [
    'the extension may import the panel and the host adapters',
    'packages/extension/src/probe.ts',
    `import { storyOverlay } from '@once-upon-a-diff/panel/overlay';\nimport { createHostPage } from '@once-upon-a-diff/shared/host/diff-dom';`,
    [],
  ],
  // outside every layer
  [
    'tests cross packages freely',
    'packages/extension/test/probe.ts',
    `import { x } from 'once-upon-a-diff/types';\nimport fs from 'node:fs';`,
    [],
  ],
  // the test kit is dev-only: tests import it, nothing that ships does, and it imports no package of this repo
  ...[
    'packages/bridge/src/services/probe.ts',
    'packages/bridge/src/adapters/probe.ts',
    'packages/bridge/src/server/probe.ts',
    'packages/bridge/src/cli/probe.ts',
    'packages/web/public/probe.ts',
    'packages/web/public/board/header/probe.ts',
    'packages/panel/src/probe.ts',
    'packages/panel/src/ask/probe.ts',
    'packages/shared/src/util/probe.ts',
    'packages/shared/src/host/probe.ts',
    'packages/protocol/src/probe.ts',
    'packages/extension/src/probe.ts',
  ].map((file): [string, string, string, string[]] => [
    `${file} imports the test kit by name`,
    file,
    `import { tmp } from '@once-upon-a-diff/test-kit/files';`,
    [IMPORTS],
  ]),
  [
    'a service imports the test kit dynamically',
    'packages/bridge/src/services/probe.ts',
    `await import('@once-upon-a-diff/test-kit/dom');`,
    [SYNTAX],
  ],
  [
    'a page imports the test kit by path',
    'packages/web/public/probe.ts',
    `import { tmp } from '../../test-kit/src/files.ts';`,
    [PATHS],
  ],
  [
    'shared imports the test kit by path',
    'packages/shared/src/probe.ts',
    `import { tmp } from '../../test-kit/src/files.ts';`,
    [PATHS],
  ],
  [
    'the kit imports the bridge by name',
    'packages/test-kit/src/probe.ts',
    `import { createBridge } from 'once-upon-a-diff/server/index';`,
    [IMPORTS],
  ],
  [
    'the kit imports the protocol by name',
    'packages/test-kit/src/probe.ts',
    `import { ROUTES } from '@once-upon-a-diff/protocol/routes';`,
    [IMPORTS],
  ],
  [
    'the kit imports the pages by path',
    'packages/test-kit/src/probe.ts',
    `import { splitRows } from '../../web/public/split.ts';`,
    [PATHS],
  ],
  [
    'the kit may import Node, linkedom and itself',
    'packages/test-kit/src/probe.ts',
    `import os from 'node:os';\nimport { parseHTML } from 'linkedom';\nimport { tmp } from './files.ts';`,
    [],
  ],
  [
    'the bridge entry point imports the test kit by name',
    'packages/bridge/bin/once-upon.ts',
    `import { tmp } from '@once-upon-a-diff/test-kit/files';`,
    [IMPORTS],
  ],
  [
    'the bridge entry point imports the panel by name',
    'packages/bridge/bin/once-upon.ts',
    `import { x } from '@once-upon-a-diff/panel/body';`,
    [IMPORTS],
  ],
  [
    'the bridge entry point may import both apps',
    'packages/bridge/bin/once-upon.ts',
    `import { createBridge } from '../src/server/index.ts';\nimport { main } from '../src/cli/index.ts';`,
    [],
  ],
  [
    'a test may import the test kit',
    'packages/bridge/test/probe.ts',
    `import { tmp } from '@once-upon-a-diff/test-kit/files';`,
    [],
  ],
];

for (const [name, filePath, code, expected] of CASES) {
  test(`boundary lint: ${name}`, async () => {
    assert.deepEqual(await boundaryRules(filePath, code), expected.sort());
  });
}
