/*
 * Probes for the side-effect lint (eslint.side-effects.mjs): only an adapter runs a program, writes a file or reaches the
 * network. Each case lints a snippet as if it sat in a given folder and checks which of those rules fires, so a rule that
 * stops matching, or a block that gets a rule replaced by a later one, fails here instead of going quiet.
 * Which package, layer or region may import which is dependency-cruiser's job (.dependency-cruiser.mjs), not ESLint's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SIDE_EFFECT_RULES = new Set([
  'no-restricted-imports',
  'no-restricted-syntax',
  'no-restricted-globals',
  'no-restricted-properties',
]);

const eslint = new ESLint({ cwd: ROOT });

const sideEffectRules = async (filePath: string, code: string): Promise<string[]> => {
  const [result] = await eslint.lintText(code, { filePath: `${ROOT}${filePath}` });
  const rules = result.messages.flatMap((message) =>
    message.ruleId && SIDE_EFFECT_RULES.has(message.ruleId) ? [message.ruleId] : [],
  );
  return [...new Set(rules)].sort();
};

const IMPORTS = 'no-restricted-imports';
const SYNTAX = 'no-restricted-syntax';
const GLOBALS = 'no-restricted-globals';
const PROPERTIES = 'no-restricted-properties';

// [name, file the snippet pretends to be, snippet, the rules that must fire]
const CASES: [string, string, string, string[]][] = [
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
];

for (const [name, filePath, code, expected] of CASES) {
  test(`side-effect lint: ${name}`, async () => {
    assert.deepEqual(await sideEffectRules(filePath, code), expected.sort());
  });
}
