/** The status line step of `once-upon setup` and doctor's Status line check: the board's context and usage need a status line. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson, runCli } from './helpers.ts';
import { doctor } from '@once-upon-a-diff/core/orchestration/bridge/doctor';
import { ROOT } from './script-helpers.ts';
import { statusLineStep } from '@once-upon-a-diff/core/features/sessions/status-line-setup';

const SESSION = 'aaaaaaaa-1111-2222-3333-444444444444';
const SNIPPET = path.join(ROOT, 'extras/statusline-snippet.sh');

/** A home whose sessions folder holds this test process as a live Claude session. */
function homeWithLiveSession(kind?: string): string {
  const home = tmp('statusline-doctor');
  const sessions = tmp('statusline-doctor-sessions');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  writeJson(path.join(sessions, `${process.pid}.json`), {
    pid: process.pid,
    sessionId: SESSION,
    cwd: '/a',
    kind,
  });
  return home;
}
function writeLine(home: string, ageMs: number): void {
  const file = path.join(home, 'statusline', `${SESSION}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ session_id: SESSION, at: 1, context: 5 }));
  const when = new Date(Date.now() - ageMs);
  utimesSync(file, when, when);
}
async function statusLine(home: string): Promise<string | undefined> {
  const out: string[] = [];
  await doctor(home, { token: 't', port: 1 }, { out: (line) => out.push(line) });
  return out.find((one) => one.includes('Status line:'));
}

test('doctor warns when sessions are live and none has written a status line file, with the fix', async () => {
  const home = homeWithLiveSession('interactive');
  const line = await statusLine(home);
  assert.match(line ?? '', /^WARN/);
  assert.match(line ?? '', /1 live Claude session/);
  const out: string[] = [];
  await doctor(home, { token: 't', port: 1 }, { out: (one) => out.push(one) });
  assert.match(out.join('\n'), /once-upon setup/);
  // a file older than six hours is no better than none
  writeLine(home, 7 * 3600 * 1000);
  assert.match((await statusLine(home)) ?? '', /^WARN/);
});

test('doctor passes with a fresh status line file, and has nothing to say with no live session', async () => {
  const home = homeWithLiveSession();
  writeLine(home, 60 * 1000);
  assert.match((await statusLine(home)) ?? '', /^PASS/);
  const quiet = tmp('statusline-doctor-none');
  writeJson(path.join(quiet, 'config.json'), { board_sessions_dir: tmp('statusline-no-sessions') });
  assert.equal(await statusLine(quiet), undefined);
  // a session that is not interactive has no status line to wait for
  assert.equal(await statusLine(homeWithLiveSession('bg')), undefined);
});

test('setup prints the settings entry when Claude Code has no status line, and writes nothing', async () => {
  const home = tmp('statusline-setup');
  const claude = tmp('statusline-setup-claude');
  const run = await runCli(home, ['setup'], { CLAUDE_CONFIG_DIR: claude });
  assert.equal(run.code, 0);
  assert.match(run.stdout, /Claude Code has no status line yet/);
  assert.ok(run.stdout.includes(`"statusLine": { "type": "command", "command": "${SNIPPET}" }`));
  assert.throws(() => readFileSync(path.join(claude, 'settings.json')));
});

test('setup leaves an existing status line alone and prints the line to add to it', async () => {
  const home = tmp('statusline-setup-existing');
  const claude = tmp('statusline-setup-existing-claude');
  const settings = JSON.stringify({ statusLine: { type: 'command', command: '~/bin/mine.sh' } });
  writeFileSync(path.join(claude, 'settings.json'), settings);
  const run = await runCli(home, ['setup'], { CLAUDE_CONFIG_DIR: claude });
  assert.match(run.stdout, /already have a status line \(~\/bin\/mine\.sh\)/);
  assert.ok(run.stdout.includes(`printf '%s' "$input" | ${SNIPPET}`));
  assert.doesNotMatch(run.stdout, /"statusLine"/);
  assert.equal(readFileSync(path.join(claude, 'settings.json'), 'utf8'), settings);
});

test('setup says so, and prints nothing to add, once a status line is writing', async () => {
  const home = tmp('statusline-setup-fresh');
  writeLine(home, 1000);
  const run = await runCli(home, ['setup'], {
    CLAUDE_CONFIG_DIR: tmp('statusline-setup-fresh-claude'),
  });
  assert.match(run.stdout, /already writing them/);
  assert.doesNotMatch(run.stdout, /statusline-snippet/);
});

test('setup quotes a snippet path with a space or quote, for the shell and inside the settings JSON', () => {
  const snippet = "/Users/a b/it's/extras/statusline-snippet.sh";
  const quoted = `'/Users/a b/it'\\''s/extras/statusline-snippet.sh'`;
  const none = statusLineStep(tmp('statusline-quote-home'), snippet, tmp('statusline-quote-none'));
  const entry = none.find((line) => line.includes('"statusLine"')) ?? '';
  const parsed = JSON.parse(`{${entry}}`);
  assert.equal(parsed.statusLine.command, quoted);
  const settings = JSON.stringify({ statusLine: { type: 'command', command: '~/bin/mine.sh' } });
  const claude = tmp('statusline-quote-existing');
  writeFileSync(path.join(claude, 'settings.json'), settings);
  const existing = statusLineStep(tmp('statusline-quote-home2'), snippet, claude);
  assert.ok(existing.includes(`  printf '%s' "$input" | ${quoted}`));
});

test('setup says the snippet is already set up but writes nothing, when the status line command runs it', async () => {
  const home = tmp('statusline-setup-snippet');
  const claude = tmp('statusline-setup-snippet-claude');
  writeFileSync(
    path.join(claude, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: SNIPPET } }),
  );
  const run = await runCli(home, ['setup'], { CLAUDE_CONFIG_DIR: claude });
  assert.match(run.stdout, /already set up/);
  assert.match(run.stdout, /jq/);
  assert.doesNotMatch(run.stdout, /printf '%s' "\$input"/);
});
