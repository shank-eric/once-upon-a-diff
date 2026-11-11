/*
 * `backlog claim` and `agent start` check the folded log and then append. Each does both under the log's lock, so two CLI
 * calls milliseconds apart cannot both pass the check. The lock is held here by this process, then raced from two children.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { withLock } from '@once-upon-a-diff/adapters/stores/fs/lock';
import { BacklogStore, cardLookup } from '../src/queues/backlog/backlog.ts';
import { AgentRegistry } from '../src/records/agents/registry.ts';

const src = (file: string) => JSON.stringify(path.resolve(import.meta.dirname, '../src', file));
const RACE_MS = 60_000;
const SID = 'eeea873a';
/** Blocks this process (it holds a lock meanwhile) so a child has time to try. */
const hold = (millis: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, millis);

/** Runs `body` (with `home`, `card` and `name` in scope) in one child per name, all released at once. Resolves with each one's printed result. */
async function race(body: string, home: string, card: string, names: string[]): Promise<string[]> {
  const dir = tmp('log-locks');
  const goFile = path.join(dir, 'go');
  const script = path.join(dir, 'child.ts');
  writeFileSync(
    script,
    `import { existsSync } from 'node:fs';
import { BacklogStore, cardLookup } from ${src('queues/backlog/backlog.ts')};
import { AgentRegistry } from ${src('records/agents/registry.ts')};
const [go, home, card, name] = process.argv.slice(2);
process.stderr.write('ready\\n');
while (!existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
try { process.stdout.write(String(${body})); } catch (err) { process.stdout.write('refused: ' + err.message); }
`,
  );
  let ready = 0;
  const procs = names.map((name) =>
    spawn(process.execPath, [script, goFile, home, card, name], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  const timer = setTimeout(() => procs.forEach((child) => child.kill('SIGKILL')), RACE_MS);
  try {
    return await Promise.all(
      procs.map(
        (child) =>
          new Promise<string>((resolve, reject) => {
            let out = '';
            child.stdout.on('data', (chunk) => (out += chunk));
            child.stderr.on('data', (chunk) => {
              if (String(chunk).includes('ready') && ++ready === names.length) {
                writeFileSync(goFile, '');
              }
            });
            child.on('close', (code) =>
              code === 0 ? resolve(out) : reject(new Error(`child failed (${code})`)),
            );
          }),
      ),
    );
  } finally {
    clearTimeout(timer);
    procs.forEach((child) => child.kill('SIGKILL'));
  }
}

/** Starts `body` in a child that prints `done` when it ends; resolves with the child to wait for. */
function child(body: string) {
  const script = path.join(tmp('log-locks-hold'), 'child.ts');
  writeFileSync(
    script,
    `import { BacklogStore, cardLookup } from ${src('queues/backlog/backlog.ts')};
import { AgentRegistry } from ${src('records/agents/registry.ts')};
const [home, card] = process.argv.slice(2);
${body}
process.stdout.write('done');
`,
  );
  return (home: string, card: string) =>
    spawn(process.execPath, [script, home, card], { stdio: ['ignore', 'pipe', 'inherit'] });
}

const ended = (proc: ReturnType<typeof spawn>) =>
  new Promise<void>((resolve) => proc.on('close', () => resolve()));

function world() {
  const home = tmp('log-locks-home');
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Locked', repo: 'shank-eric/larmor' });
  store.start(item.id, { branch: 'locked' });
  return { home, store, item };
}

test('a claim waits for the backlog log’s lock', async () => {
  const { home, store, item } = world();
  const claimer = child(`new BacklogStore(home).claim(card, { agent: 'held' });`);
  let proc: ReturnType<typeof spawn> | null = null;
  try {
    withLock(store.file, () => {
      proc = claimer(home, item.id);
      hold(1000);
      assert.equal(store.items()[0].claim, null, 'no claim goes in while the lock is held');
    });
    await ended(proc!);
    assert.equal(store.items()[0].claim?.agent, 'held');
  } finally {
    (proc as ReturnType<typeof spawn> | null)?.kill('SIGKILL');
  }
});

test('an agent start waits for the agents log’s lock', async () => {
  const { home, item } = world();
  new BacklogStore(home).claim(item.id, { agent: 'one' });
  const registry = new AgentRegistry(home, undefined, cardLookup(new BacklogStore(home)));
  const starter = child(
    `new AgentRegistry(home, undefined, cardLookup(new BacklogStore(home))).start({ name: 'one', sid: '${SID}', kind: 'author', task: 't', card });`,
  );
  let proc: ReturnType<typeof spawn> | null = null;
  try {
    withLock(registry.file, () => {
      proc = starter(home, item.id);
      hold(1000);
      assert.equal(registry.agents().length, 0, 'no run starts while the lock is held');
    });
    await ended(proc!);
    assert.equal(registry.agents().length, 1);
  } finally {
    (proc as ReturnType<typeof spawn> | null)?.kill('SIGKILL');
  }
  assert.ok(!existsSync(`${registry.file}.lock`));
});

test('two author starts on one card at once leave one open author', async () => {
  const { home, store, item } = world();
  store.claim(item.id, { agent: 'one' });
  const outs = await race(
    `(new AgentRegistry(home, undefined, cardLookup(new BacklogStore(home))).start({ name, sid: '${SID}', kind: 'author', task: 't', card }), 'started')`,
    home,
    item.id,
    ['one', 'two'],
  );
  assert.equal(outs.filter((out) => out === 'started').length, 1);
  assert.equal(outs.filter((out) => /already has an open author/.test(out)).length, 1);
  const registry = new AgentRegistry(home);
  assert.equal(registry.agents().filter((one) => one.card === item.id).length, 1);
});
