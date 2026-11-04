import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmp } from './helpers.ts';
import { appendAgentEvent, readAgentsFile } from '../src/adapters/stores/agents-file.ts';
import { appendBacklogEvent, readBacklogFile } from '../src/adapters/stores/backlog-file.ts';
import {
  readBridgeFile,
  tokenFingerprint,
  writeBridgeFile,
} from '../src/adapters/stores/bridge-file.ts';
import { markFinished, readFinished } from '../src/adapters/stores/finished-agents.ts';
import { readGithubAnswers, writeGithubAnswers } from '../src/adapters/stores/github-answers.ts';
import {
  appendUsageLine,
  readUsageText,
  writeUsageJson,
} from '../src/adapters/stores/usage-file.ts';
import { appendLine } from '../src/adapters/stores/fs/lines.ts';
import { jsonLines } from '../src/adapters/stores/fs/jsonl.ts';
import { parseAgentEvents } from '../src/services/ledger/events.ts';
import { foldBacklog } from '../src/services/backlog/backlog.ts';

const text = (file: string) => readFileSync(file, 'utf8');
const mode = (file: string) => statSync(file).mode & 0o777;

// These bytes are what main wrote before the stores' tidy-up: a change here is a change to the user's files.

test('agents.jsonl: one compact event a line, 0600, no time added', () => {
  const file = path.join(tmp('fmt-agents'), 'agents.jsonl');
  assert.equal(readAgentsFile(file), '');
  appendAgentEvent(file, { v: 1, op: 'beat', id: 'abcdef01:x', at: '2026-11-04T10:00:00.000Z' });
  appendAgentEvent(file, { v: 1, op: 'finish', id: 'abcdef01:x' });
  assert.equal(
    text(file),
    '{"v":1,"op":"beat","id":"abcdef01:x","at":"2026-11-04T10:00:00.000Z"}\n{"v":1,"op":"finish","id":"abcdef01:x"}\n',
  );
  assert.equal(readAgentsFile(file), text(file));
  assert.equal(mode(file), 0o600);
});

test('backlog.jsonl: one event a line, stamped with the time last, 0600', () => {
  const file = path.join(tmp('fmt-backlog'), 'backlog.jsonl');
  assert.equal(readBacklogFile(file), '');
  const before = Date.now();
  appendBacklogEvent(file, { op: 'add', id: 'bl_abc123', title: 't' });
  appendBacklogEvent(file, { op: 'edit', at: 'old', id: 'bl_abc123' });
  const raw = text(file);
  const [one, two] = raw.split('\n');
  assert.ok(raw.endsWith('}\n'));
  const stamp = JSON.parse(one).at as string;
  assert.ok(Date.parse(stamp) >= before - 1000 && Date.parse(stamp) <= Date.now());
  assert.equal(one, `{"op":"add","id":"bl_abc123","title":"t","at":"${stamp}"}`);
  // an `at` in the event keeps its place in the line and takes the stamp
  assert.match(two, /^\{"op":"edit","at":"\d{4}-[\d\-T:.]+Z","id":"bl_abc123"\}$/);
  assert.equal(readBacklogFile(file), raw);
  assert.equal(mode(file), 0o600);
});

test('both logs start a new line after a torn last line', () => {
  const dir = tmp('fmt-torn');
  const agents = path.join(dir, 'agents.jsonl');
  const backlog = path.join(dir, 'backlog.jsonl');
  writeFileSync(agents, '{"op":"beat"');
  writeFileSync(backlog, '{"op":"add","id"');
  appendAgentEvent(agents, { op: 'finish' });
  appendBacklogEvent(backlog, { op: 'add', id: 'bl_abc123', title: 't' });
  assert.equal(text(agents), '{"op":"beat"\n{"op":"finish"}\n');
  assert.match(
    text(backlog),
    /^\{"op":"add","id"\n\{"op":"add","id":"bl_abc123","title":"t","at":"[^"]+"\}\n$/,
  );
  assert.equal(
    foldBacklog(text(backlog))
      .map((item) => item.id)
      .join(),
    'bl_abc123',
  );
});

test('lines that are not objects are skipped by both folds', () => {
  const junk = 'null\n5\n[]\n"x"\ntrue\n\n{not json\n';
  assert.deepEqual(parseAgentEvents(junk), []);
  assert.deepEqual(foldBacklog(junk), []);
  assert.deepEqual(jsonLines(junk), [null, 5, [], 'x', true]);
  const good = '{"op":"add","id":"bl_abc123","title":"t"}\n';
  assert.deepEqual(
    foldBacklog(`${junk}${good}${junk}`).map((item) => item.id),
    ['bl_abc123'],
  );
  const event = {
    v: 1,
    op: 'beat',
    id: 'abcdef01:x',
    sid8: 'abcdef01',
    name: 'x',
    at: '2026-11-04T10:00:00Z',
  };
  assert.deepEqual(parseAgentEvents(`${junk}${JSON.stringify(event)}\n${junk}`), [event]);
});

test('appendLine: a bare line, a guarded new line, no forced mode', () => {
  const file = path.join(tmp('fmt-lines'), 'ledger.md');
  appendLine(file, 'one');
  appendFileSync(file, 'two');
  appendLine(file, 'three');
  assert.equal(text(file), 'one\ntwo\nthree\n');
  assert.notEqual(mode(file) & 0o044, 0, 'made with the default mode, not 0600');
});

test('bridge.json, finished-agents.json, github-answers.json: 2-space JSON, no final newline', () => {
  const home = tmp('fmt-json');
  writeBridgeFile(home, 4823, 'tok');
  assert.equal(
    text(path.join(home, 'bridge.json')),
    `{\n  "pid": ${process.pid},\n  "port": 4823,\n  "token": "${tokenFingerprint('tok')}"\n}`,
  );
  assert.equal(readBridgeFile(home)?.port, 4823);
  markFinished(home, 'abcdef01:x', 5);
  assert.equal(text(path.join(home, 'finished-agents.json')), '{\n  "abcdef01:x": 5\n}');
  assert.equal(readFinished(home).get('abcdef01:x'), 5);
  writeGithubAnswers(home, { branches: {}, prs: {}, requested: null });
  assert.equal(
    text(path.join(home, 'github-answers.json')),
    '{\n  "version": 1,\n  "branches": {},\n  "prs": {},\n  "requested": null\n}',
  );
  assert.deepEqual(readGithubAnswers(home), { branches: {}, prs: {}, requested: null });
});

test('usage/: JSON files and the capped log are 0600 in a 0700 folder', () => {
  const home = tmp('fmt-usage');
  writeUsageJson(home, 'settings.json', { epoch: 1 });
  assert.equal(text(path.join(home, 'usage', 'settings.json')), '{\n  "epoch": 1\n}');
  assert.equal(mode(path.join(home, 'usage', 'settings.json')), 0o600);
  assert.equal(mode(path.join(home, 'usage')), 0o700);
  appendUsageLine(home, 'cli.log', 'a', 100);
  appendUsageLine(home, 'cli.log', 'b', 100);
  assert.equal(readUsageText(home, 'cli.log'), 'a\nb\n');
  assert.equal(mode(path.join(home, 'usage', 'cli.log')), 0o600);
  appendUsageLine(home, 'cli.log', 'c', 4);
  assert.equal(readUsageText(home, 'cli.log'), 'a\nb\n', 'at the cap: nothing more is written');
});
