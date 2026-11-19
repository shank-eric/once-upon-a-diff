/**
 * The bridge token lives in <home>/token and not in config.json: what the CLI prints, what `config get` refuses, how doctor
 * and deploy-local.sh read it, and that a migrated home still authenticates the CLI's links.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmp, startBridge, runCli, localRepo, writeJson, TOKEN } from './helpers.ts';
import { createLocalStory } from '@once-upon-a-diff/stories/local-story';
import { doctor } from '@once-upon-a-diff/core/orchestration/bridge/doctor';
import { readConfig } from '@once-upon-a-diff/foundation/settings';
import { pageKey } from '@once-upon-a-diff/state/records/page-links/page-key';

const seed = (home: string) => {
  writeFileSync(path.join(home, 'token'), `${TOKEN}\n`, { mode: 0o600 });
  writeJson(path.join(home, 'config.json'), { port: 1, house_rules: 'be brief', n: 3, flag: true });
  chmodSync(path.join(home, 'config.json'), 0o600);
};

test('token and setup never print the value to a pipe (not a terminal), they name the file', async () => {
  const home = tmp('token-print');
  seed(home);
  const piped = await runCli(home, ['token']);
  assert.equal(piped.code, 0);
  assert.ok(!piped.stdout.includes(TOKEN));
  assert.match(piped.stdout, /not printed.*token/);
  const setup = await runCli(home, ['setup']);
  assert.ok(!setup.stdout.includes(TOKEN));
  assert.match(setup.stdout, /Bridge port:\s+1/);
});

test('token --rotate changes only the token file, leaves config.json token-free, and keeps mode 600', async () => {
  const home = tmp('token-rotate');
  seed(home);
  const config = readFileSync(path.join(home, 'config.json'), 'utf8');
  const rotated = await runCli(home, ['token', '--rotate']);
  const fresh = readFileSync(path.join(home, 'token'), 'utf8').trim();
  assert.ok(!rotated.stdout.includes(fresh));
  assert.notEqual(fresh, TOKEN);
  assert.equal(readFileSync(path.join(home, 'token'), 'utf8'), `${fresh}\n`);
  assert.equal(readFileSync(path.join(home, 'config.json'), 'utf8'), config);
  assert.equal(readConfig(home).token, fresh);
  assert.equal((statSync(path.join(home, 'token')).mode & 0o777).toString(8), '600');
});

test('config get prints one setting, refuses the token, and exits 1 for a setting that is not set', async () => {
  const home = tmp('config-get');
  seed(home);
  assert.equal((await runCli(home, ['config', 'get', 'house_rules'])).stdout, 'be brief\n');
  assert.equal((await runCli(home, ['config', 'get', 'n'])).stdout, '3\n');
  assert.equal((await runCli(home, ['config', 'get', 'flag'])).stdout, 'true\n');
  assert.equal((await runCli(home, ['config', 'get', 'port'])).stdout, '1\n');
  for (const args of [
    ['config', 'get', 'token'],
    ['config', 'get', 'nope'],
    ['config', 'get'],
    ['config'],
  ]) {
    const run = await runCli(home, args);
    assert.equal(run.code, 1, args.join(' '));
    assert.equal(run.stdout, '', `${args.join(' ')} printed to stdout`);
    assert.ok(!run.stderr.includes(TOKEN));
  }
  // a home that has a token in config.json (a hand edit) never prints it either
  const legacy = tmp('config-get-legacy');
  writeJson(path.join(legacy, 'config.json'), { port: 1, token: TOKEN });
  const run = await runCli(legacy, ['config', 'get', 'token']);
  assert.equal(run.code, 1);
  assert.ok(!(run.stdout + run.stderr).includes(TOKEN));
});

test('a migrated home still authenticates: the bridge accepts the key the CLI prints with --with-key', async () => {
  const home = tmp('token-migrated');
  seed(home);
  const { repo, base } = localRepo();
  const chapters = path.join(tmp('ch'), 'chapters.json');
  writeJson(chapters, {
    title: 'One',
    chapters: [
      {
        refs: [],
        title: 'Chapter 1: One',
        files: ['one.txt', 'gone.txt', 'lib/two.js'],
        comments: [],
      },
    ],
  });
  const { id } = createLocalStory({ home, repo, base, head: 'HEAD', chapters });
  const bridge = await startBridge({ home });
  try {
    const printed = await runCli(home, ['page', '--story', id, '--no-open', '--with-key']);
    const key = printed.stdout.trim().split('#key=')[1];
    assert.equal(key, pageKey(TOKEN, id));
    const story = await bridge.call('GET', `/api/stories/${encodeURIComponent(id)}`, undefined, {
      Authorization: `Bearer ${key}`,
    });
    assert.equal(story.status, 200);
    // doctor reads the token the same way (the token file), and the bridge accepts it
    const port = Number(new URL(bridge.base).port);
    const lines: string[] = [];
    await doctor(home, { ...readConfig(home), port }, { out: (line) => lines.push(line) });
    const text = lines.join('\n');
    assert.match(text, /PASS\s+Config and token/);
    assert.ok(!text.includes(TOKEN));
    assert.ok(!/FAIL\s+Bridge token/.test(text));
  } finally {
    await bridge.close();
  }
});

test('doctor fails for a home with a token only in config.json, warns for a wide token file, and fails with none', async () => {
  const run = async (home: string) => {
    const lines: string[] = [];
    await doctor(home, readConfig(home), { out: (line) => lines.push(line) });
    return lines.join('\n');
  };
  const legacy = tmp('doctor-legacy');
  writeJson(path.join(legacy, 'config.json'), { port: 1, token: TOKEN });
  chmodSync(path.join(legacy, 'config.json'), 0o600);
  const legacyText = await run(legacy);
  assert.match(legacyText, /FAIL\s+Token: .*has no token/);
  assert.ok(!legacyText.includes(TOKEN));

  const wide = tmp('doctor-wide');
  seed(wide);
  chmodSync(path.join(wide, 'token'), 0o644);
  chmodSync(path.join(wide, 'config.json'), 0o600);
  assert.match(await run(wide), /WARN\s+Config and token[^\n]*\n\s+fix: chmod 600 \S+\/token/);

  assert.match(await run(tmp('doctor-none')), /FAIL\s+Token: .*token has no token/);
});

test("deploy-local.sh reads the token from the home's token file only, never from config.json", () => {
  const lib = new URL('../../../../scripts/lib/read-token.sh', import.meta.url).pathname;
  const read = (home: string) =>
    execFileSync('bash', ['-c', `. "${lib}"; read_token`], {
      env: { PATH: process.env.PATH!, HOME: '/nonexistent', ONCE_UPON_HOME: home },
      encoding: 'utf8',
    });
  const migrated = tmp('deploy-token-new');
  writeFileSync(path.join(migrated, 'token'), `${TOKEN}\n`, { mode: 0o600 });
  assert.equal(read(migrated), TOKEN);
  const legacy = tmp('deploy-token-old');
  writeJson(path.join(legacy, 'config.json'), { port: 1, token: 'old-token-value' });
  assert.equal(read(legacy), '');
  const both = tmp('deploy-token-both');
  writeFileSync(path.join(both, 'token'), `${TOKEN}\n`, { mode: 0o600 });
  writeJson(path.join(both, 'config.json'), { port: 1, token: 'stale' });
  assert.equal(read(both), TOKEN);
  assert.equal(read(tmp('deploy-token-none')), '');
});
