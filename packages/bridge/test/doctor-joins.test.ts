import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { githubStory, tmp, writeJson } from './helpers.ts';
import { doctor } from '@once-upon-a-diff/core/orchestration/bridge/doctor';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { seenCheckout } from '@once-upon-a-diff/foundation/repos';

// `once-upon doctor` joins the stores by the keys the id module builds: a state folder to a story, an inbox entry to a
// story, a repo on a card or a cardless run to a repo something other than a typed repo vouches for. Report only.

const SID = 'eeea873a';

async function lines(home: string): Promise<{ lines: string[]; ok: boolean }> {
  const out: string[] = [];
  const ok = await doctor(home, { token: 't', port: 1 }, { out: (line) => out.push(line) });
  return { lines: out, ok };
}
const line = (all: string[], name: string) => all.find((one) => one.includes(`${name}:`)) ?? '';

/** A home with one PR story (acme/widgets#7), one local story, and an index entry whose story folder is gone. */
function world() {
  const home = tmp('doctor-joins-home');
  githubStory(path.join(home, 'acme-widgets-7'));
  githubStory(path.join(home, 'local-thing'), { meta: { kind: 'local' } });
  writeJson(path.join(home, 'stories.json'), { 'gone-story-1': path.join(home, 'gone-story-1') });
  for (const folder of ['acme-widgets-7', 'pr-acme-widgets-7', 'local-thing', 'gone-story-1']) {
    mkdirSync(path.join(home, 'state', folder), { recursive: true });
    writeJson(path.join(home, 'state', folder, 'position.json'), {});
  }
  return home;
}

const inboxLine = (story: string) =>
  JSON.stringify({
    id: `q_${story}`,
    at: '2026-11-06T00:00:00.000Z',
    type: 'question',
    story,
    text: 'why?',
  });

test('state folders that match no story are listed; per-PR folders, story ids and index ids are not', async () => {
  const home = world();
  const clean = await lines(home);
  assert.match(line(clean.lines, 'State folders'), /^PASS/);

  mkdirSync(path.join(home, 'state', 'ghost-3'), { recursive: true });
  writeJson(path.join(home, 'state', 'ghost-3', 'position.json'), {});
  mkdirSync(path.join(home, 'state', 'pr-acme-gadgets-9'), { recursive: true });
  // a PR key that a build request names is not an orphan, though its story has no folder
  mkdirSync(path.join(home, 'state', 'pr-acme-bolts-4'), { recursive: true });
  new Builds(home).save({
    'acme/bolts#4': {
      id: 'b_1',
      repo: 'acme/bolts',
      number: 4,
      url: null,
      requested_at: '2026-11-06T00:00:00.000Z',
      status: 'done',
    } as never,
  });
  const found = line((await lines(home)).lines, 'State folders');
  assert.match(found, /^WARN/);
  assert.match(found, /2 to look at/);
  assert.match(found, /ghost-3/);
  assert.match(found, /pr-acme-gadgets-9/);
  assert.doesNotMatch(found, /acme-widgets-7|local-thing|gone-story-1|pr-acme-bolts-4/);
});

test('inbox story ids with no story are listed with their event counts', async () => {
  const home = world();
  writeFileSync(
    path.join(home, 'inbox.jsonl'),
    [inboxLine('acme-widgets-7'), inboxLine('gone-story-1')].join('\n') + '\n',
  );
  assert.match(line((await lines(home)).lines, 'Inbox stories'), /^PASS/);

  writeFileSync(
    path.join(home, 'inbox.jsonl'),
    [inboxLine('acme-widgets-7'), ...[1, 2, 3].map(() => inboxLine('ghost-3'))].join('\n') + '\n',
  );
  const found = line((await lines(home)).lines, 'Inbox stories');
  assert.match(found, /^WARN/);
  assert.match(found, /ghost-3 \(3 events\)/);
  assert.doesNotMatch(found, /acme-widgets-7/);
});

test('a repo on a card or a cardless run that a typo of a known repo is listed with the repo it reads as', async () => {
  const home = world();
  seenCheckout(home, 'acme/widgets', home);
  const store = new BacklogStore(home);
  store.add({ title: 'fine', repo: 'Acme/Widgets' });
  const typo = store.add({ title: 'typo card', repo: 'acme/widgts' });
  store.drop(typo.id);
  new AgentRegistry(home).start({
    name: 'lost-helper',
    sid: SID,
    kind: 'helper',
    task: 't',
    repo: 'acne/widgets',
    at: new Date(),
  });
  const found = line((await lines(home)).lines, 'Repos');
  assert.match(found, /^WARN/);
  assert.match(found, /acme\/widgts.*card.*dropped.*acme\/widgets/);
  assert.match(found, /acne\/widgets.*lost-helper.*acme\/widgets/);
  assert.doesNotMatch(found, /Acme\/Widgets/);
});

test('two owners of one name are an info line, never a warning, and the exit code is unchanged', async () => {
  const home = world();
  const store = new BacklogStore(home);
  store.add({ title: 'one', repo: 'ann/tool' });
  store.add({ title: 'two', repo: 'bob/tool' });
  const { lines: all } = await lines(home);
  assert.match(line(all, 'Repos'), /^PASS/);
  const info = all.filter((one) => one.startsWith('INFO'));
  assert.ok(info.some((one) => /tool/.test(one) && /ann\/tool/.test(one) && /bob\/tool/.test(one)));
  assert.doesNotMatch(all.join('\n'), /WARN.*(ann|bob)\/tool/);
  // the failing Bridge line is the only thing that fails, as without the joins
  assert.equal((all.at(-1) ?? '').includes('1 failing'), true);
});

test('doctor writes nothing: no file, folder, mode or time changes in the home', async () => {
  const home = world();
  // mkdtemp makes it 0700, which is what a chmod by `new Inbox(home)` would set: start apart from it so one would show
  chmodSync(home, 0o755);
  mkdirSync(path.join(home, 'state', 'ghost-3'), { recursive: true });
  writeFileSync(path.join(home, 'inbox.jsonl'), inboxLine('ghost-3') + '\n');
  const snapshot = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      const info = statSync(file);
      const row = `${file} ${info.mode} ${info.size} ${info.mtimeMs}`;
      return entry.isDirectory() ? [row, ...snapshot(file)] : [row];
    });
  const before = [`${home} ${statSync(home).mode}`, ...snapshot(home)];
  await lines(home);
  assert.deepEqual([`${home} ${statSync(home).mode}`, ...snapshot(home)], before);
});

test('a home with everything joined passes the three joins', async () => {
  const home = world();
  const { lines: all } = await lines(home);
  for (const name of ['State folders', 'Inbox stories', 'Repos']) {
    assert.match(line(all, name), /^PASS/, name);
  }
});

test('short sibling repos and numbered ones are not typos of each other', async () => {
  const home = world();
  seenCheckout(home, 'acme/api', home);
  seenCheckout(home, 'acme/svc-1', home);
  const store = new BacklogStore(home);
  for (const repo of ['acme/app', 'acme/ui', 'acme/svc-2', 'c/d']) {
    store.add({ title: repo, repo });
  }
  store.add({ title: 'one edit in a long name', repo: 'acme/widgetz-service' });
  seenCheckout(home, 'acme/widgets-service', home);
  const found = line((await lines(home)).lines, 'Repos');
  assert.match(found, /^WARN/);
  assert.match(found, /acme\/widgetz-service.*looks like acme\/widgets-service/);
  assert.doesNotMatch(found, /acme\/app|acme\/ui|acme\/svc-2|c\/d/);
});

test('a state folder doctor cannot read gets its own warning, and the rest are still checked', async () => {
  const home = world();
  mkdirSync(path.join(home, 'state', 'ghost-3'), { recursive: true });
  writeFileSync(path.join(home, 'state', 'ghost-3', 'position.json'), '{}');
  const locked = path.join(home, 'state', 'locked-story');
  mkdirSync(locked, { recursive: true });
  chmodSync(locked, 0o000);
  try {
    const { lines: all } = await lines(home);
    assert.match(line(all, 'State folders'), /^WARN.*ghost-3/);
    assert.match(line(all, 'Unreadable state folders'), /^WARN.*locked-story/);
  } finally {
    chmodSync(locked, 0o755);
  }
});
