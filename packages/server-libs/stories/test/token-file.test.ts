/** The bridge token lives in <home>/token, never in config.json: the move, the races, the modes and the read-only paths. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { readJson } from '@once-upon-a-diff/adapters/stores/fs/json-file';
import {
  loadConfig,
  readConfig,
  readSettings,
  saveConfig,
  saveToken,
} from '@once-upon-a-diff/foundation/settings';

const modeOf = (file: string) => (statSync(file).mode & 0o777).toString(8);
const LEGACY = 'legacy-token-value-aaaaaaaaaaaaaaaa';
const tokenOf = (home: string) => readFileSync(path.join(home, 'token'), 'utf8');
const configOf = (home: string) =>
  readJson<Record<string, unknown>>(path.join(home, 'config.json'))!;

/** Runs `run` with console.error captured, and returns the lines it printed. */
const stderrOf = (run: () => void): string => {
  const errors: string[] = [];
  const was = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    run();
  } finally {
    console.error = was;
  }
  return errors.join('\n');
};

test('a token key in config.json is not read: a new token is made, the key leaves, every other setting stays in order, and the note never prints a token', () => {
  const home = tmp('token-legacy');
  writeJson(path.join(home, 'config.json'), {
    port: 4900,
    house_rules: 'be brief',
    token: LEGACY,
    checkout_dirs: ['/x'],
    repos: { widgets: { keep_branches: true } },
  });
  let cfg: ReturnType<typeof loadConfig> | undefined;
  const note = stderrOf(() => {
    cfg = loadConfig(home);
  });
  assert.notEqual(cfg!.token, LEGACY);
  assert.equal(tokenOf(home), `${cfg!.token}\n`);
  assert.equal(modeOf(path.join(home, 'token')), '600');
  assert.deepEqual(Object.entries(configOf(home)), [
    ['port', 4900],
    ['house_rules', 'be brief'],
    ['checkout_dirs', ['/x']],
    ['repos', { widgets: { keep_branches: true } }],
  ]);
  assert.deepEqual(readSettings(home).repos['widgets'], { keep_branches: true });
  assert.equal(modeOf(path.join(home, 'config.json')), '600');
  assert.ok(!readFileSync(path.join(home, 'config.json'), 'utf8').includes(LEGACY));
  assert.match(note, /no longer read/);
  assert.ok(!note.includes(LEGACY) && !note.includes(cfg!.token));
  // a second load changes neither file, mints no new token and says nothing
  const before = [tokenOf(home), readFileSync(path.join(home, 'config.json'), 'utf8')];
  assert.equal(
    stderrOf(() => {
      assert.equal(loadConfig(home).token, cfg!.token);
    }),
    '',
  );
  assert.deepEqual([tokenOf(home), readFileSync(path.join(home, 'config.json'), 'utf8')], before);
});

test('a fresh home: the token file and a config.json with the port only', () => {
  const home = tmp('token-fresh');
  const cfg = loadConfig(home);
  assert.match(cfg.token, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(tokenOf(home), `${cfg.token}\n`);
  assert.deepEqual(Object.keys(configOf(home)), ['port']);
  assert.equal(modeOf(home), '700');
  assert.equal(loadConfig(home).token, cfg.token);
});

test('a stray token key leaves config.json and the token file is untouched', () => {
  const home = tmp('token-both');
  writeFileSync(path.join(home, 'token'), 'file-token-bbbbbbbbbbbbbbbbbbbbbb\n', { mode: 0o600 });
  writeJson(path.join(home, 'config.json'), { port: 4901, token: LEGACY });
  assert.equal(readConfig(home).token, 'file-token-bbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(loadConfig(home).token, 'file-token-bbbbbbbbbbbbbbbbbbbbbb');
  assert.deepEqual(configOf(home), { port: 4901 });
});

test('an empty or whitespace token file counts as missing: a new token replaces it, never the one in config.json', () => {
  const home = tmp('token-empty');
  writeFileSync(path.join(home, 'token'), '  \n', { mode: 0o600 });
  writeJson(path.join(home, 'config.json'), { port: 4902, token: LEGACY });
  assert.equal(readConfig(home).token, '');
  const token = loadConfig(home).token;
  assert.notEqual(token, LEGACY);
  assert.match(token, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(tokenOf(home), `${token}\n`);
});

test('loadConfig tightens a wide token file, readConfig leaves it alone', () => {
  const home = tmp('token-mode');
  loadConfig(home);
  chmodSync(path.join(home, 'token'), 0o644);
  readConfig(home);
  assert.equal(modeOf(path.join(home, 'token')), '644');
  loadConfig(home);
  assert.equal(modeOf(path.join(home, 'token')), '600');
});

test('readConfig on a home whose token is only in config.json returns no token and writes nothing', () => {
  const home = tmp('token-readonly');
  writeJson(path.join(home, 'config.json'), { port: 4903, token: LEGACY });
  const before = readFileSync(path.join(home, 'config.json'), 'utf8');
  assert.equal(readConfig(home).token, '');
  assert.equal(readFileSync(path.join(home, 'config.json'), 'utf8'), before);
  assert.deepEqual(readdirSync(home), ['config.json']);
  // and a home with neither reads as no token
  assert.equal(readConfig(tmp('token-none')).token, '');
});

test('saveConfig never writes a token, and saveToken changes only the token file and keeps mode 600', () => {
  const home = tmp('token-save');
  const cfg = loadConfig(home);
  saveConfig({ ...cfg, house_rules: 'x' }, home);
  assert.deepEqual(configOf(home), { port: cfg.port, house_rules: 'x' });
  const config = readFileSync(path.join(home, 'config.json'), 'utf8');
  saveToken('rotated-token-cccccccccccccccccccc', home);
  assert.equal(tokenOf(home), 'rotated-token-cccccccccccccccccccc\n');
  assert.equal(modeOf(path.join(home, 'token')), '600');
  assert.equal(readFileSync(path.join(home, 'config.json'), 'utf8'), config);
  assert.equal(loadConfig(home).token, 'rotated-token-cccccccccccccccccccc');
});

test('dropping a token key leaves every other setting: a setting edited since the first read is kept', () => {
  const home = tmp('token-reread');
  writeJson(path.join(home, 'config.json'), { port: 4904, token: LEGACY, a: 1 });
  loadConfig(home);
  writeJson(path.join(home, 'config.json'), { port: 4904, token: LEGACY, a: 1, edited: true });
  loadConfig(home);
  assert.deepEqual(configOf(home), { port: 4904, a: 1, edited: true });
});

test('an unreadable config.json: its copy is mode 600, and a token file already there is kept (no new token)', () => {
  const home = tmp('token-unreadable');
  writeFileSync(path.join(home, 'token'), 'file-token-dddddddddddddddddddddd\n', { mode: 0o600 });
  writeFileSync(path.join(home, 'config.json'), '{"token":"half-written');
  const errors: string[] = [];
  const was = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    assert.equal(loadConfig(home).token, 'file-token-dddddddddddddddddddddd');
  } finally {
    console.error = was;
  }
  const kept = readdirSync(home).filter((name) => name.startsWith('config.json.unreadable-'));
  assert.equal(kept.length, 1);
  assert.equal(modeOf(path.join(home, kept[0])), '600');
  assert.match(errors.join('\n'), /not JSON/);
  assert.ok(!errors.join('\n').includes('new token'));
  assert.deepEqual(Object.keys(configOf(home)), ['port']);
});

test('two processes loading one fresh home end with the same token, the one in the file', async () => {
  const home = tmp('token-race');
  const script = `
    import { loadConfig } from '@once-upon-a-diff/foundation/settings';
    process.stdout.write(loadConfig(process.argv[1]).token);
  `;
  const run = () =>
    new Promise<string>((resolve, reject) => {
      // perl's alarm is the hard timeout: macOS has no `timeout`
      const child = spawn(
        'perl',
        ['-e', 'alarm 30; exec @ARGV', process.execPath, '--input-type=module', '-e', script, home],
        { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'inherit'] },
      );
      let text = '';
      child.stdout.on('data', (chunk) => (text += chunk));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(text) : reject(new Error(`exit ${code}`))));
    });
  const tokens = await Promise.all([run(), run(), run(), run()]);
  assert.equal(new Set(tokens).size, 1);
  assert.equal(tokenOf(home), `${tokens[0]}\n`);
  assert.deepEqual(
    readdirSync(home).filter((name) => name.endsWith('.tmp')),
    [],
  );
});
