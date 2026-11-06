/*
 * The CLI never calls the server (ADR-15): it reads and writes the shared files through core, and `serve` is the process becoming
 * the server. The one exception is the doctor's health check (core/src/adapters/bridge-health.ts). dependency-cruiser names the
 * imports that could make a call (`health-check-is-the-doctors`, `cli-and-core-have-no-route-table`), but a graph cannot see a
 * `fetch`, a socket, a signal, or a program run as `curl`, so this test is the real guard. It reads every source file the CLI
 * process can run (cli, core, the shell's bin and instrumentation) and lists each line that could reach the bridge. The list
 * must equal the one below, both ways, line by line: a new line, a second `fetch` or `kill` in a file that has one, or a changed
 * line is a decision made in this file's diff, and an entry nothing matches any more is removed. The HTTP app (packages/server)
 * is the server and is not scanned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import typescript from 'typescript';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** Every folder must exist: a folder renamed away must fail here, not stop being scanned. */
const SCANNED = [
  'packages/cli/src',
  'packages/core/src',
  'packages/bridge/bin',
  'packages/bridge/instrumentation',
];

const NETWORK_MODULE =
  /^(node:)?(http|https|http2|net|dgram|tls)$|^(undici|ws|node-fetch|axios|got)(\/|$)/;
const NETWORK_GLOBAL = new Set(['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']);
const PROGRAM = /(^|[\s/])(curl|wget|nc|ncat|socat|telnet|kill|pkill|killall)(\s|$)/;

/**
 * Every line of one source file that could reach the bridge, as `<kind> <file> :: <the line, trimmed>` (kinds: `network-module`,
 * `network-global`, `request`, `kill`, `connect`, `program`, `loopback`, `api-path`), one for each kind on each line.
 */
export function reachesFor(file: string, text: string): string[] {
  const found = new Set<string>();
  const source = typescript.createSourceFile(file, text, typescript.ScriptTarget.Latest, true);
  const add = (kind: string, node: typescript.Node) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.add(`${kind} ${file} :: ${text.split('\n')[line].trim()}`);
  };
  const literal = (value: string, node: typescript.Node) => {
    if (PROGRAM.test(value)) {
      add('program', node);
    }
    if (/127\.0\.0\.1|localhost/.test(value)) {
      add('loopback', node);
    }
    if (value.includes('/api/')) {
      add('api-path', node);
    }
  };
  const visit = (node: typescript.Node): void => {
    if (
      (typescript.isImportDeclaration(node) || typescript.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      typescript.isStringLiteral(node.moduleSpecifier) &&
      NETWORK_MODULE.test(node.moduleSpecifier.text)
    ) {
      add('network-module', node);
    }
    if (typescript.isCallExpression(node)) {
      const [first] = node.arguments;
      const dynamic =
        node.expression.kind === typescript.SyntaxKind.ImportKeyword ||
        (typescript.isIdentifier(node.expression) && node.expression.text === 'require');
      // a module named by something other than a literal could be any
      if (
        dynamic &&
        (!first || !typescript.isStringLiteralLike(first) || NETWORK_MODULE.test(first.text))
      ) {
        add('network-module', node);
      }
    }
    if (typescript.isIdentifier(node) && NETWORK_GLOBAL.has(node.text)) {
      add('network-global', node);
    }
    if (
      typescript.isNewExpression(node) &&
      typescript.isIdentifier(node.expression) &&
      node.expression.text === 'Request'
    ) {
      add('request', node);
    }
    if (typescript.isIdentifier(node) && ['kill', 'signalProcess'].includes(node.text)) {
      add('kill', node);
    }
    if (typescript.isIdentifier(node) && ['connect', 'createConnection'].includes(node.text)) {
      add('connect', node);
    }
    if (typescript.isStringLiteralLike(node)) {
      literal(node.text, node);
    } else if (
      typescript.isTemplateHead(node) ||
      typescript.isTemplateMiddle(node) ||
      typescript.isTemplateTail(node)
    ) {
      literal(node.text, node);
    }
    typescript.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort();
}

const typeScriptFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : typeScriptFiles(full);
    }
    return /\.(ts|mjs|js)$/.test(entry.name) ? [full] : [];
  });

/** What the scanned sources reach, sorted. */
const scan = (): string[] =>
  SCANNED.flatMap((dir) => {
    assert.ok(
      existsSync(path.join(ROOT, dir)),
      `${dir} is scanned but does not exist: rename it here too`,
    );
    return typeScriptFiles(path.join(ROOT, dir));
  })
    .flatMap((file) =>
      reachesFor(path.relative(ROOT, file).split(path.sep).join('/'), readFileSync(file, 'utf8')),
    )
    .sort();

/**
 * Every line that may reach the bridge or the loopback, and why it is not a call to the server. Add a line only for one that is
 * not one; a call to the server is the doctor's health check and nothing else.
 */
const ALLOWED: Record<string, string> = {
  'connect packages/core/src/adapters/usage/session.ts :: session.connect();':
    'the V8 inspector session of the usage capture: in this process, no socket',
  'api-path packages/core/src/adapters/bridge-health.ts :: const response = await fetch(`http://127.0.0.1:${port}/api/health`, {':
    "the doctor's health check: the one allowed call to the server",
  'loopback packages/core/src/adapters/bridge-health.ts :: const response = await fetch(`http://127.0.0.1:${port}/api/health`, {':
    'the same call',
  'network-global packages/core/src/adapters/bridge-health.ts :: const response = await fetch(`http://127.0.0.1:${port}/api/health`, {':
    'the same call',
  'kill packages/core/src/adapters/claude-sessions/live-sessions.ts :: process.kill(live.pid, 0);':
    "signal 0 only asks whether a Claude session's process exists",
  'kill packages/core/src/adapters/os.ts :: process.kill(pid, 0);':
    'pidAlive: signal 0 only asks whether a process exists',
  "loopback packages/cli/src/commands/bridge.ts :: '  once-upon serve   [--port N]                                  run the bridge on 127.0.0.1',":
    'the usage text of `serve`',
  "loopback packages/core/src/adapters/os.ts :: probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));":
    'portTaken binds the port to see whether it is free: it connects to nothing',
  "network-module packages/core/src/adapters/os.ts :: import net from 'node:net';":
    "the import behind portTaken's bind (no connect call is allowed: see the `connect` kind)",
  'loopback packages/core/src/orchestration/bridge/bridge.ts :: `listening on http://127.0.0.1:${port}, pid ${process.pid} (stories: ${server.stories.list().length}, inbox: ${server.inbox.file})`,':
    'a log line of the bridge itself',
  "loopback packages/core/src/orchestration/bridge/bridge.ts :: server.listen(port, '127.0.0.1', () => {":
    'the bridge listening: this process is the server (`serve`)',
  'loopback packages/core/src/orchestration/bridge/doctor.ts :: : `nothing is listening on 127.0.0.1:${port}`,':
    "the doctor's message",
  "loopback packages/core/src/orchestration/bridge/doctor.ts :: `running on 127.0.0.1:${port}, version ${health.body.version}${proc ? `, pid ${proc.pid}` : ''}`,":
    "the doctor's message",
  "loopback packages/core/src/records/page-links/address.ts :: const LOOPBACK = new Set(['127.0.0.1', '::1']);":
    'a set of names to recognise, not an address to reach',
  'loopback packages/core/src/records/page-links/address.ts :: return (local ? undefined : await publicOriginOf(home)) ?? `http://127.0.0.1:${port}`;':
    'the address printed in a link for the user',
  'loopback packages/core/src/records/page-links/page-key.ts :: `http://127.0.0.1:${port}/local/${encodeURIComponent(story)}/#key=${(readOnly ? viewKey : pageKey)(token, story)}`;':
    'the address printed in a link for the user',
  'loopback packages/core/src/records/page-links/page-key.ts :: origin = `http://127.0.0.1:${port}`,':
    'the address printed in a link for the user',
};

test('the CLI never calls the server: nothing in cli, core or the shell reaches it but the doctor’s health check', () => {
  const found = scan();
  const allowed = Object.keys(ALLOWED).sort();
  assert.deepEqual(
    {
      'lines that could reach the bridge and are not in ALLOWED (a call to the server belongs in no file but the doctor’s health check)':
        found.filter((one) => !allowed.includes(one)),
      'entries in ALLOWED that no line matches any more': allowed.filter(
        (one) => !found.includes(one),
      ),
    },
    {
      'lines that could reach the bridge and are not in ALLOWED (a call to the server belongs in no file but the doctor’s health check)':
        [],
      'entries in ALLOWED that no line matches any more': [],
    },
  );
});

test('the scan finds a call to the server however it is written, and names the line', () => {
  const cases: [string, string, string[]][] = [
    [
      'fetch',
      "const r = await fetch('http://127.0.0.1:4823/api/board');",
      ['api-path', 'loopback', 'network-global'],
    ],
    ['fetch by reference', 'const call = globalThis.fetch;', ['network-global']],
    ['http module', "import http from 'node:http';", ['network-module']],
    ['dynamic import', "const net = await import('node:net');", ['network-module']],
    ['require of a computed name', 'const m = require(name);', ['network-module']],
    ['a socket library', "import WebSocket from 'ws';", ['network-global', 'network-module']],
    ['a socket connect', 'const socket = net.connect(port, host);', ['connect']],
    ['a program', "execFile('curl', ['-s', url]);", ['program']],
    ['a program in a command line', "execSync('nc -z localhost 4823');", ['loopback', 'program']],
    ['a signal', "process.kill(pid, 'SIGUSR2');", ['kill']],
    ['a request object', "new Request('x');", ['request']],
    ['a path in a template', 'const url = `${base}/api/health`;', ['api-path']],
    ['nothing', "import path from 'node:path'; const x = path.join('a', 'b');", []],
  ];
  for (const [name, code, kinds] of cases) {
    assert.deepEqual(
      reachesFor('probe.ts', code).map((one) => one.split(' ')[0]),
      kinds,
      name,
    );
  }
  assert.deepEqual(reachesFor('probe.ts', 'const a = 1;\n  process.kill(pid, 0);\n'), [
    'kill probe.ts :: process.kill(pid, 0);',
  ]);
});

test('a second call in a file that already has an allowed one is a new line, so it is not allowed', () => {
  const os = [
    'export function pidAlive(pid: number) {',
    '  process.kill(pid, 0);',
    '}',
    'export function ask(pid: number) {',
    "  process.kill(pid, 'SIGUSR2');",
    '}',
    "const socket = net.connect(4823, '127.0.0.1');",
  ].join('\n');
  const found = reachesFor('packages/core/src/adapters/os.ts', os);
  const fresh = found.filter((one) => !(one in ALLOWED));
  assert.deepEqual(
    fresh.map((one) => one.split(' ')[0]),
    ['connect', 'kill', 'loopback'],
    'the signal and the connect are not the allowed lines',
  );
  const health = reachesFor(
    'packages/core/src/adapters/bridge-health.ts',
    'const board = await fetch(`http://127.0.0.1:${port}/api/board`);',
  );
  assert.ok(
    health.every((one) => !(one in ALLOWED)),
    'a second fetch in the health check is not allowed',
  );
});

test('a scanned folder that is gone fails the scan', () => {
  const missing = 'packages/not-a-folder/src';
  assert.throws(
    () =>
      assert.ok(existsSync(path.join(ROOT, missing)), `${missing} is scanned but does not exist`),
    /does not exist/,
  );
  for (const dir of SCANNED) {
    assert.ok(existsSync(path.join(ROOT, dir)), `${dir} must exist`);
  }
});
