import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, startBridge, TOKEN, type TestBridge } from './helpers.ts';
import { portState } from '@once-upon-a-diff/core/orchestration/bridge/bridge';

const open: TestBridge[] = [];
after(() => Promise.all(open.map((bridge) => bridge.close())));

test('`once-upon local` knows its own bridge on the port from a stranger, without calling it', async () => {
  const home = tmp('port-state');
  const bridge = await startBridge({ home });
  open.push(bridge);
  const port = Number(new URL(bridge.base).port);
  const file = path.join(home, 'bridge.json');
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(written.pid, process.pid);
  assert.equal(written.port, port);
  assert.ok(
    !JSON.stringify(written).includes(TOKEN),
    'the file holds a fingerprint, never the token',
  );
  assert.equal(await portState(home, port, TOKEN), 'ours');
  assert.equal(
    await portState(home, String(port)),
    'ours',
    'a port given as text, and no token to compare',
  );
  assert.equal(
    await portState(home, port, 'a-newer-token'),
    'old-token',
    'a bridge that started before `once-upon token --rotate` is not the one this config opens',
  );
  assert.equal(
    await portState(tmp('port-state-other-home'), port, TOKEN),
    'foreign',
    'another home’s bridge (or one with no file) is not ours',
  );
  // a file whose process is gone, over a port something else holds, is not a bridge either
  const gone = spawnSync('true').pid!;
  writeFileSync(file, JSON.stringify({ ...written, pid: gone }));
  assert.equal(await portState(home, port, TOKEN), 'foreign');
  writeFileSync(file, JSON.stringify({ ...written, port: port + 1 }));
  assert.equal(await portState(home, port, TOKEN), 'foreign', 'the file names another port');
  writeFileSync(file, JSON.stringify(written));

  await bridge.close();
  assert.equal(existsSync(file), false, 'the file goes when the bridge closes');
  assert.equal(await portState(home, port, TOKEN), 'free');

  // some other program on the port, with a file left behind by a bridge that was killed
  const stranger = net.createServer();
  await new Promise<void>((resolve) => stranger.listen(port, '127.0.0.1', resolve));
  writeFileSync(file, JSON.stringify({ ...written, pid: gone }));
  assert.equal(await portState(home, port, TOKEN), 'foreign');
  rmSync(file);
  assert.equal(await portState(home, port, TOKEN), 'foreign');
  await new Promise((resolve) => stranger.close(resolve));
});
