import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.ts';
import { Inbox } from '@once-upon-a-diff/state/queues/requests/inbox';

// Two `once-upon wait` processes under one consumer name (two sessions on /once-upon-listen owner/repo, or a second wait
// started while the first runs) share a cursor: a question asked to them is handed over once.

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/once-upon.ts');

const wait = (home: string): Promise<{ code: number | null; stdout: string }> =>
  new Promise((resolve) => {
    const clean = { ...process.env };
    delete clean.CLAUDE_CODE_SESSION_ID;
    const child = spawn(
      process.execPath,
      [BIN, 'wait', '--repo', 'acme/widgets', '--type', 'question', '--timeout', '6'],
      { env: { ...clean, ONCE_UPON_HOME: home } },
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('close', (code) => resolve({ code, stdout }));
  });

test('two waits under one consumer name deliver a question once', { timeout: 60_000 }, async () => {
  const home = tmp('home');
  const inbox = new Inbox(home);
  inbox.setCursor('repo-acme-widgets', 0);
  const waits = [wait(home), wait(home)];
  await new Promise((resolve) => setTimeout(resolve, 2500)); // both are waiting
  inbox.append({
    type: 'question',
    id: 'q_once',
    story: 'acme-widgets-7',
    repo: 'acme/widgets',
    step: 1,
    text: 'Why?',
  });
  const runs = await Promise.all(waits);
  assert.equal(runs.filter((run) => run.stdout.includes('q_once')).length, 1);
});
