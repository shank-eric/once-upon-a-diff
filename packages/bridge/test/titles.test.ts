import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.ts';
import { projectFolder } from '../src/board/blank.ts';
import { SessionTitles } from '../src/board/titles.ts';

const SESSION = '11111111-aaaa-bbbb-cccc-dddddddddddd';
const NOW = Date.parse('2026-10-27T15:00:00Z');

const lines = (...items: unknown[]) => items.map((item) => JSON.stringify(item)).join('\n') + '\n';
const aiTitle = (text: string) => ({ type: 'ai-title', aiTitle: text, sessionId: SESSION });
const said = (text: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: text },
});

function put(projects: string, cwd: string, id: string, text: string): string {
  const file = path.join(projects, projectFolder(cwd), `${id}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

test('a session’s title is the last ai-title in its transcript, read again only when the file grows', async () => {
  const projects = tmp('titles-projects');
  const cwd = '/Users/eric/Development/widgets';
  const file = put(projects, cwd, SESSION, lines(aiTitle('Cypress fixes'), said('done')));
  const titles = new SessionTitles();
  assert.equal(await titles.titleOf(projects, SESSION, cwd, NOW), 'Cypress fixes');
  assert.equal(await titles.titleOf(projects, SESSION, cwd, NOW), 'Cypress fixes');
  assert.equal(titles.reads, 1, 'same size: not read again');
  appendFileSync(file, lines(aiTitle('K12 monitor alerts'), said('looking')));
  assert.equal(await titles.titleOf(projects, SESSION, cwd, NOW), 'K12 monitor alerts');
  // a line still being written, cut short, says nothing and the last whole one stands
  appendFileSync(file, '{"type":"ai-title","aiTi');
  assert.equal(await titles.titleOf(projects, SESSION, cwd, NOW), 'K12 monitor alerts');
});

test('a title far back is found past the first tail read; a transcript with none, or no transcript, has none', async () => {
  const projects = tmp('titles-far');
  const cwd = '/Users/eric/Development/widgets';
  const long = said('x'.repeat(200 * 1024));
  put(projects, cwd, SESSION, lines(aiTitle('Long turn'), long));
  const titles = new SessionTitles();
  assert.equal(await titles.titleOf(projects, SESSION, cwd, NOW), 'Long turn');
  const other = '22222222-aaaa-bbbb-cccc-dddddddddddd';
  put(projects, cwd, other, lines(said('messages from another session only')));
  assert.equal(await titles.titleOf(projects, other, cwd, NOW), null);
  assert.equal(
    await titles.titleOf(projects, '33333333-aaaa-bbbb-cccc-dddddddddddd', cwd, NOW),
    null,
  );
});

test('a transcript in another project folder (the session’s cwd changed) is found', async () => {
  const projects = tmp('titles-moved');
  put(projects, '/Users/eric/Development/started-here', SESSION, lines(aiTitle('Moved session')));
  const titles = new SessionTitles();
  assert.equal(
    await titles.titleOf(projects, SESSION, '/Users/eric/Development/now-here', NOW),
    'Moved session',
  );
});
