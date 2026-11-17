/**
 * `agent ack NAME`: a failed run is acknowledged, so it stops holding its card in Waiting (the board reads `acked`). It writes
 * one `ack` row, no ledger line, and changes nothing about the run. Only a failed run can be acked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runCli, tmp, writeJson } from './helpers.ts';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';

const SID = 'abcdef01';
const OTHER = '12345678';

function world() {
  const home = tmp('ack-home');
  const ledger = path.join(tmp('ack-notes'), 'ledger.md');
  writeFileSync(ledger, '');
  writeJson(path.join(home, 'config.json'), { board_ledger_file: ledger });
  const registry = new AgentRegistry(home, { ledger, progress: null });
  const ack = (...args: string[]) => runCli(home, ['agent', 'ack', ...args]);
  const acks = () => registry.events().filter((one) => one.op === 'ack');
  return { home, ledger, registry, ack, acks };
}

const begin = (registry: AgentRegistry, name: string, sid = SID) =>
  registry.start({ name, sid, kind: 'author', task: 'x' });

test('ack of a failed run exits 0 and writes one ack row, no ledger line, and the run stays as it was', async () => {
  const { home, registry, ack, acks, ledger } = world();
  begin(registry, 'ou-broke');
  registry.finish('ou-broke', { sid: SID, state: 'failed', outcome: 'broke' });
  const ledgerBefore = readFileSync(ledger, 'utf8');
  const out = await ack('ou-broke');
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /ou-broke/);
  assert.equal(acks().length, 1);
  assert.equal(acks()[0].run, registry.agents()[0].run);
  assert.equal(readFileSync(ledger, 'utf8'), ledgerBefore);
  const [run] = registry.agents();
  assert.equal(run.state, 'failed');
  assert.equal(run.outcome, 'broke');
  assert.ok(run.acked);
  // still in the list of every run, and a finish of it is still refused
  const all = await runCli(home, ['agent', 'list', '--all']);
  assert.match(all.stdout, /ou-broke/);
  const refused = await runCli(home, ['agent', 'finish', 'ou-broke', '--sid', SID]);
  assert.notEqual(refused.code, 0);
});

test('only a failed run is acknowledged: running, waiting, plan, done and stopped runs and an unknown name are refused', async () => {
  const { registry, ack, acks } = world();
  begin(registry, 'ou-running');
  begin(registry, 'ou-waiting');
  registry.state('ou-waiting', { sid: SID, state: 'waiting', outcome: 'which?' });
  for (const [name, state] of [
    ['ou-done', 'done'],
    ['ou-stopped', 'stopped'],
  ] as const) {
    begin(registry, name);
    registry.finish(name, { sid: SID, state });
  }
  for (const name of ['ou-running', 'ou-waiting', 'ou-done', 'ou-stopped', 'ou-ghost']) {
    const out = await ack(name);
    assert.notEqual(out.code, 0, name);
    assert.match(out.stderr, /failed|no run/, name);
  }
  assert.equal(acks().length, 0);
});

test('a second ack says so and writes nothing; a restart of the name is a new run, unacked', async () => {
  const { registry, ack, acks } = world();
  begin(registry, 'ou-broke');
  registry.finish('ou-broke', { sid: SID, state: 'failed' });
  await ack('ou-broke');
  const again = await ack('ou-broke');
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already/);
  assert.equal(acks().length, 1);
  begin(registry, 'ou-broke');
  assert.equal(registry.agents()[0].acked, undefined);
});

test('two sessions with a failed run of the name need --sid; with it only that run is acked', async () => {
  const { registry, ack, acks } = world();
  for (const sid of [SID, OTHER]) {
    begin(registry, 'ou-broke', sid);
    registry.finish('ou-broke', { sid, state: 'failed' });
  }
  const unclear = await ack('ou-broke');
  assert.notEqual(unclear.code, 0);
  assert.match(unclear.stderr, /--sid/);
  assert.equal(acks().length, 0);
  const picked = await ack('ou-broke', '--sid', OTHER);
  assert.equal(picked.code, 0, picked.stderr);
  assert.deepEqual(
    acks().map((one) => one.sid8),
    [OTHER],
  );
});
