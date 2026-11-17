/** Larmor (voice) is optional: with no `board_larmor_dir` the board shows no voice, and nothing else asks for Larmor. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson, startBridge, runCli, TOKEN, type TestBridge } from './helpers.ts';
import { fakeLarmor } from '@once-upon-a-diff/state/test/board-fixtures';
import { boardKey } from '@once-upon-a-diff/state/records/page-links/page-key';
import type { BoardData } from '@once-upon-a-diff/contracts/types';
import { ROOT } from './script-helpers.ts';

const open: TestBridge[] = [];
after(() => Promise.all(open.map((bridge) => bridge.close())));

test('with no board_larmor_dir the board has no voice, and every voice route refuses', async () => {
  const bridge = await startBridge({ home: tmp('no-larmor-bridge-blank') });
  open.push(bridge);
  const key = { Authorization: `Bearer ${boardKey(TOKEN)}` };
  const board = (await bridge.call<BoardData>('GET', '/api/board', undefined, key)).body;
  assert.equal(board.voice, null);
  assert.equal(board.phone, null);
  assert.equal(board.voice_start, null);
  assert.equal(board.voice_paused, false);
  // each body is valid, so Larmor's absence is the only reason left to refuse
  const posts: [string, unknown][] = [
    ['start', {}],
    ['stop', {}],
    ['pause', { paused: true }],
    ['phone', { on: true }],
    ['phone/bridge-stop', {}],
  ];
  const home = tmp('no-larmor-bridge');
  const send = (target: TestBridge, route: string, body: unknown) =>
    target.call('POST', `/api/board/voice/${route}`, body, key);
  for (const [route, body] of posts) {
    const res = await send(bridge, route, body);
    assert.equal(res.status, 400, `${route}: ${res.text}`);
  }
  // control: the same requests are not refused as malformed once a Larmor is configured
  writeJson(path.join(home, 'config.json'), { board_larmor_dir: fakeLarmor(tmp('voice')) });
  const withLarmor = await startBridge({ home });
  open.push(withLarmor);
  for (const [route, body] of posts) {
    const res = await send(withLarmor, route, body);
    assert.notEqual(res.status, 400, `${route}: ${res.text}`);
  }
});

test('the CLI on a blank home never mentions Larmor', async () => {
  const home = tmp('blank-home-cli');
  // HOME too, so the CLI never reads this machine's ~/.once-upon or ~/.larmor
  const env = { HOME: tmp('blank-user-home'), USERPROFILE: tmp('blank-user-home') };
  for (const args of [['doctor'], ['agent', 'list']]) {
    const { stdout, stderr } = await runCli(home, args, env);
    assert.doesNotMatch(stdout + stderr, /larmor/i, args.join(' '));
  }
});

test('nothing shipped calls Larmor’s tools', () => {
  const found: string[] = [];
  const walk = (file: string) => {
    if (statSync(file).isDirectory()) {
      for (const name of readdirSync(file)) {
        walk(path.join(file, name));
      }
    } else if (/\.(md|sh|json|mjs|js|ts)$|^[^.]+$/.test(path.basename(file))) {
      if (/mcp__larmor|start_voice|end_voice/.test(readFileSync(file, 'utf8'))) {
        found.push(file);
      }
    }
  };
  for (const dir of ['skills', 'agents', 'extras', 'scripts', 'README.md']) {
    walk(path.join(ROOT, dir));
  }
  assert.deepEqual(found, []);
});
