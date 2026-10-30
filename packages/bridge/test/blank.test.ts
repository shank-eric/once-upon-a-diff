import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.ts';
import { BlankSessions, projectFolder, showsUse } from '../src/adapters/claude-sessions/blank.ts';

const SESSION = '11111111-aaaa-bbbb-cccc-dddddddddddd';
const NOW = Date.parse('2026-10-27T15:00:00Z');

const lines = (...items: unknown[]) => items.map((item) => JSON.stringify(item)).join('\n') + '\n';
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content },
  ...extra,
});
/** The lines Claude Code writes for a session that was just cleared. */
const cleared = [
  { type: 'mode', mode: 'normal', sessionId: SESSION },
  { type: 'file-history-snapshot', messageId: 'a', snapshot: {}, isSnapshotUpdate: false },
  user('<local-command-caveat>The command below was run directly</local-command-caveat>', {
    isMeta: true,
  }),
  user(
    '<command-name>/clear</command-name>\n <command-message>clear</command-message>\n <command-args></command-args>',
  ),
  {
    type: 'system',
    subtype: 'local_command',
    content: '<local-command-stdout></local-command-stdout>',
  },
];

function put(projects: string, cwd: string, id: string, text: string): string {
  const file = path.join(projects, projectFolder(cwd), `${id}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

test('the project folder is the cwd with every non-alphanumeric character as a dash', () => {
  assert.equal(projectFolder('/Users/eric/Development/SDK'), '-Users-eric-Development-SDK');
  assert.equal(projectFolder('/a/my.repo_x y/z-1'), '-a-my-repo-x-y-z-1');
});

test('what counts as use: an assistant line or a real prompt, not commands, caveats, meta lines or subagents', () => {
  assert.equal(showsUse(user('fix the build')), true);
  assert.equal(showsUse(user([{ type: 'text', text: 'what is this? [Image #1]' }])), true);
  assert.equal(showsUse(user([{ type: 'image', source: {} }])), true);
  assert.equal(
    showsUse(
      user([
        { type: 'text', text: '<ide_opened_file>the user opened a.ts</ide_opened_file>' },
        { type: 'text', text: 'why?' },
      ]),
    ),
    true,
  );
  assert.equal(showsUse({ type: 'assistant', message: { content: [] } }), true);
  // a slash command alone, its caveat and its output are not a prompt
  assert.equal(
    showsUse(
      user(
        '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>',
      ),
    ),
    false,
  );
  assert.equal(showsUse(user('<command-name>/model</command-name>')), false);
  assert.equal(
    showsUse(user('<local-command-stdout>Set model to Opus</local-command-stdout>')),
    false,
  );
  assert.equal(
    showsUse(user('<local-command-caveat>x</local-command-caveat>', { isMeta: true })),
    false,
  );
  assert.equal(
    showsUse(user('Another Claude session sent a message: hello', { isMeta: true })),
    false,
  );
  assert.equal(showsUse(user('a subagent’s prompt', { isSidechain: true })), false);
  assert.equal(showsUse({ type: 'assistant', isSidechain: true }), false);
  assert.equal(showsUse({ type: 'system', content: 'x' }), false);
  assert.equal(showsUse(user(42)), false);
});

test('a transcript is blank when missing, or when it holds only commands', async () => {
  const projects = tmp('blank-projects');
  const blank = new BlankSessions();
  const cwd = '/work/my.repo';
  // no transcript at all
  assert.equal(await blank.isBlank(projects, SESSION, cwd, NOW), true);
  put(projects, cwd, SESSION, lines(...cleared));
  assert.equal(await blank.isBlank(projects, SESSION, cwd, NOW + 1), true);
  // /clear then /exit, /login, /model: still no prompt
  const other = '22222222-aaaa-bbbb-cccc-dddddddddddd';
  put(
    projects,
    cwd,
    other,
    lines(
      ...cleared,
      user('<local-command-caveat>Caveat</local-command-caveat>', { isMeta: true }),
      user('<command-name>/model</command-name>'),
      user('<local-command-stdout>Set model to Opus</local-command-stdout>'),
    ),
  );
  assert.equal(await blank.isBlank(projects, other, cwd, NOW), true);
  // a cross-session meta line alone is not a prompt
  const meta = '33333333-aaaa-bbbb-cccc-dddddddddddd';
  put(
    projects,
    cwd,
    meta,
    lines(...cleared, user('Another Claude session sent a message: hi', { isMeta: true })),
  );
  assert.equal(await blank.isBlank(projects, meta, cwd, NOW), true);
});

test('a transcript with a prompt or an assistant line is not blank, including a slash command that starts a turn', async () => {
  const projects = tmp('blank-projects');
  const blank = new BlankSessions();
  const cwd = '/work/widgets';
  const prompt = 'aaaaaaaa-aaaa-bbbb-cccc-dddddddddddd';
  put(projects, cwd, prompt, lines(...cleared, user('fix the build')));
  assert.equal(await blank.isBlank(projects, prompt, cwd, NOW), false);
  const skill = 'bbbbbbbb-aaaa-bbbb-cccc-dddddddddddd';
  put(
    projects,
    cwd,
    skill,
    lines(
      user(
        '<command-message>once-upon-listen</command-message>\n<command-name>/once-upon-listen</command-name>',
      ),
      { type: 'assistant', message: { content: [] } },
    ),
  );
  assert.equal(await blank.isBlank(projects, skill, cwd, NOW), false);
});

test('reading crosses chunk edges, ignores a half-written last line, and stops looking in a huge file', async () => {
  const projects = tmp('blank-projects');
  const blank = new BlankSessions();
  const cwd = '/work/widgets';
  // a 200 KB line of something else between the clear and a prompt
  const junk = { type: 'attachment', content: 'x'.repeat(200 * 1024) };
  const late = 'cccccccc-aaaa-bbbb-cccc-dddddddddddd';
  put(projects, cwd, late, lines(...cleared, junk, user('after a long line')));
  assert.equal(await blank.isBlank(projects, late, cwd, NOW), false);
  const quiet = 'dddddddd-aaaa-bbbb-cccc-dddddddddddd';
  put(projects, cwd, quiet, lines(...cleared, junk));
  assert.equal(await blank.isBlank(projects, quiet, cwd, NOW), true);
  // a last line still being written is not read
  const partial = 'eeeeeeee-aaaa-bbbb-cccc-dddddddddddd';
  put(projects, cwd, partial, lines(...cleared) + JSON.stringify(user('half a pro')).slice(0, 30));
  assert.equal(await blank.isBlank(projects, partial, cwd, NOW), true);
  // 4 MB with no prompt in it is not a blank session
  const huge = 'ffffffff-aaaa-bbbb-cccc-dddddddddddd';
  put(
    projects,
    cwd,
    huge,
    lines(...cleared, { type: 'attachment', content: 'y'.repeat(5 * 1024 * 1024) }),
  );
  assert.equal(await blank.isBlank(projects, huge, cwd, NOW), false);
});

test('a transcript in another project folder is found, and one that appears later is noticed', async () => {
  const projects = tmp('blank-projects');
  const blank = new BlankSessions();
  // the session started in one folder and moved: the registry's cwd names another
  put(projects, '/where/it/started', SESSION, lines(...cleared, user('a prompt')));
  assert.equal(await blank.isBlank(projects, SESSION, '/where/it/is/now', NOW), false);
  // a session with no transcript anywhere: blank, and found as soon as it appears (after the retry wait)
  const fresh = '99999999-aaaa-bbbb-cccc-dddddddddddd';
  assert.equal(await blank.isBlank(projects, fresh, '/new/place', NOW), true);
  put(projects, '/new/place', fresh, lines(...cleared, user('first prompt')));
  assert.equal(
    await blank.isBlank(projects, fresh, '/new/place', NOW + 1000),
    false,
    'the derived path is checked every time',
  );
});

test('polls closer together than the rescan wait do not push the next search out of reach', async () => {
  const projects = tmp('blank-projects');
  const blank = new BlankSessions();
  const id = '88888888-aaaa-bbbb-cccc-dddddddddddd';
  // no transcript yet: searched once at NOW, and the board then polls every 3 s
  assert.equal(await blank.isBlank(projects, id, '/start/here', NOW), true);
  // the transcript turns up in a folder other than the cwd's, between polls
  put(projects, '/somewhere/else', id, lines(...cleared, user('a prompt')));
  for (const wait of [3000, 6000, 9000]) {
    assert.equal(await blank.isBlank(projects, id, '/start/here', NOW + wait), true, `${wait}`);
  }
  assert.equal(
    await blank.isBlank(projects, id, '/start/here', NOW + 12000),
    false,
    'searched again 10 s after the last search, not 10 s after the last poll',
  );
});

test('the answer is kept per session and file size: no second read while it is unchanged, and a prompt is final', async () => {
  const projects = tmp('blank-projects');
  const blank = new BlankSessions();
  const cwd = '/work/widgets';
  const file = put(projects, cwd, SESSION, lines(...cleared));
  assert.equal(await blank.isBlank(projects, SESSION, cwd, NOW), true);
  assert.equal(blank.reads, 1);
  assert.equal(await blank.isBlank(projects, SESSION, cwd, NOW + 3000), true);
  assert.equal(await blank.isBlank(projects, SESSION, cwd, NOW + 6000), true);
  assert.equal(blank.reads, 1, 'unchanged size, no read');
  // a command is typed: the file grows, still blank, read again
  appendFileSync(file, lines(user('<command-name>/model</command-name>')));
  assert.equal(await blank.isBlank(projects, SESSION, cwd, NOW + 9000), true);
  assert.equal(blank.reads, 2);
  // a prompt: not blank, and not looked at again
  appendFileSync(file, lines(user('now a real prompt')));
  assert.equal(await blank.isBlank(projects, SESSION, cwd, NOW + 12000), false);
  assert.equal(blank.reads, 3);
  assert.equal(await blank.isBlank(projects, SESSION, cwd, NOW + 15000), false);
  assert.equal(blank.reads, 3);
  // sessions that are gone are forgotten
  blank.keep(new Set());
  assert.equal(await blank.isBlank(projects, SESSION, cwd, NOW + 18000), false);
  assert.equal(blank.reads, 4);
});
