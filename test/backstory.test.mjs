import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tmp, git, writeJson, startBridge } from './helpers.mjs';
import { findBackstory, defaultSessionStory } from '../bridge/lib/backstory.mjs';
import { createLocalStory } from '../bridge/lib/local.mjs';
import { StoryStore, backstoryOf, storyBackstory } from '../bridge/lib/stories.mjs';

const slug = cwd => cwd.replace(/[^A-Za-z0-9]/g, '-');

/** A repo with one commit on top of base, and a Claude Code transcript that made it (an Edit, then a git commit). */
function sessionMadeRepo() {
  const repo = tmp('bs-repo');
  git(repo, 'init', '-q', '-b', 'feature');
  writeFileSync(path.join(repo, 'app.js'), 'let count = 0;\ncount = 1;\nexport default count;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const before = readFileSync(path.join(repo, 'app.js'), 'utf8');
  writeFileSync(path.join(repo, 'app.js'), 'const count = 1;\nexport default count;\n');
  git(repo, 'commit', '-q', '-am', 'chore: drop the dead initializer');
  const when = git(repo, 'log', '-1', '--format=%cI');

  const claudeDir = tmp('bs-claude');
  const cwd = tmp('bs-cwd');
  const sid = '11111111-2222-3333-4444-555555555555';
  const t = ms => new Date(Date.parse(when) - ms).toISOString();
  const base_ = { sessionId: sid, cwd, version: '2.1.0', gitBranch: 'feature', userType: 'external', isSidechain: false };
  const file = path.join(repo, 'app.js');
  const lines = [
    { ...base_, type: 'user', uuid: 'u1', parentUuid: null, timestamp: t(60000), message: { role: 'user', content: 'drop the dead initializer in app.js please' } },
    { ...base_, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: t(50000), message: { id: 'm1', role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: file, old_string: 'let count = 0;\ncount = 1;', new_string: 'const count = 1;' } }], usage: { input_tokens: 1, output_tokens: 1 } } },
    { ...base_, type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: t(49000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_edit', content: 'ok' }] }, toolUseResult: { filePath: file, oldString: 'let count = 0;\ncount = 1;', newString: 'const count = 1;', originalFile: before, structuredPatch: [] } },
    { ...base_, type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: t(20000), message: { id: 'm2', role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id: 'toolu_commit', name: 'Bash', input: { command: `cd ${repo} && git commit -q -am "chore: drop the dead initializer"` } }], usage: { input_tokens: 1, output_tokens: 1 } } },
    { ...base_, type: 'user', uuid: 'u3', parentUuid: 'a2', timestamp: t(19000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_commit', content: '' }] } },
    { ...base_, type: 'assistant', uuid: 'a3', parentUuid: 'u3', timestamp: t(10000), message: { id: 'm3', role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Dropped it and committed.' }], usage: { input_tokens: 1, output_tokens: 1 } } },
  ];
  const dir = path.join(claudeDir, slug(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sid}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return { repo, base, claudeDir, sid };
}

const haveExtractor = existsSync(path.join(defaultSessionStory(), 'bin', 'story.mjs'));

describe('backstory matcher', () => {
  test('finds the session that made the commit, and the edited lines', { skip: !haveExtractor && 'session-story not installed' }, () => {
    const { repo, base, claudeDir, sid } = sessionMadeRepo();
    const b = findBackstory({ repo, base, claudeDir, work: tmp('bs-work') });
    assert.equal(b.found, true);
    assert.equal(b.sessions.length, 1);
    assert.equal(b.sessions[0].id, sid);
    assert.equal(b.commits[0].made_in.session, sid);
    const m = b.moments[0];
    assert.ok(m.edits.some(e => e.rel === 'app.js'), 'the Edit is evidence');
    assert.deepEqual(m.lines['app.js'], [[1, 1]], 'the edit maps to the new line 1');
    assert.ok(m.asks.some(a => /dead initializer/.test(a.text)), "Eric's prompt comes along");
    assert.deepEqual(b.unmatched, []);
    assert.equal(b.timeline.length, 1);
  });

  test('skips cleanly when no session made the range (say, a PR by someone else)', { skip: !haveExtractor && 'session-story not installed' }, () => {
    const { repo, base } = sessionMadeRepo();
    const b = findBackstory({ repo, base, claudeDir: tmp('bs-empty'), work: tmp('bs-work') });
    assert.equal(b.found, false);
    assert.deepEqual(b.moments, []);
    assert.deepEqual(b.unmatched, ['app.js']);
  });

  test('skips cleanly when session-story is not installed', () => {
    const { repo, base, claudeDir } = sessionMadeRepo();
    const b = findBackstory({ repo, base, claudeDir, sessionStory: path.join(os.tmpdir(), 'no-such-session-story') });
    assert.equal(b.found, false);
    assert.match(b.reason, /isn't installed/);
  });
});

describe('backstory in the story data', () => {
  test('chapter, file and line backstories pass through, and the timeline falls back to backstory.json', async () => {
    const { repo, base } = sessionMadeRepo();
    const home = tmp('bs-home');
    const ch = path.join(tmp('bs-ch'), 'chapters.json');
    writeJson(ch, {
      title: 'T', backstory: { summary: 'Made in one session.' },
      chapters: [{
        title: 'Chapter 1: One', narrative: '### Chapter 1: One', backstory: { summary: 'Why', steps: [{ at: '2026-10-20T19:00:00Z', text: 'Asked for it', session: 's1', turn: 3 }, { text: '' }] },
        files: [{ rel: 'app.js', backstory: { text: 'Eric asked' }, lines: [{ side: 'R', start: 1, label: 'count', backstory: 'was let' }] }],
      }],
    });
    const bsFile = path.join(tmp('bs-file'), 'backstory.json');
    writeJson(bsFile, { found: true, sessions: [{ id: 's1', title: 'A session' }], moments: [{ id: 'm1', lines: { 'app.js': [[1, 1]] } }], timeline: [{ at: '2026-10-20T19:00:00Z', title: 'Drop it', text: 'Did it.', files: ['app.js'], session: 's1', turn: 3, moment: 'm1' }] });
    const made = createLocalStory({ home, repo, base, chapters: ch, backstory: bsFile });
    const data = new StoryStore({ home, scratch: false }).load(made.id);
    assert.equal(data.backstory.summary, 'Made in one session.');
    assert.equal(data.backstory.timeline.length, 1, 'timeline from backstory.json');
    assert.deepEqual(data.backstory.timeline[0].lines, { 'app.js': [[1, 1]] });
    assert.equal(data.backstory.sessions[0].label, 'A session');
    assert.equal(data.chapters[0].backstory.steps.length, 1, 'empty steps are dropped');
    assert.equal(data.chapters[0].files[0].backstory.text, 'Eric asked');
    assert.equal(data.chapters[0].files[0].lines[0].backstory, 'was let');

    const b = await startBridge({ home });
    try {
      const saved = await b.call('POST', `/api/stories/${made.id}/ui`, { n: 1, bn: 2, view: 'backstory' });
      assert.equal(saved.body.view, 'backstory');
      assert.equal((await b.call('GET', `/api/stories/${made.id}/ui`)).body.bn, 2);
      assert.equal((await b.call('POST', `/api/stories/${made.id}/ui`, { view: 'nonsense' })).body.view, 'story');
    } finally { await b.close(); }
  });

  test('no backstory at all leaves the story as it was', () => {
    assert.equal(storyBackstory(undefined, null), null);
    assert.equal(backstoryOf(null), null);
    assert.equal(backstoryOf({ steps: [] }), null);
  });
});
