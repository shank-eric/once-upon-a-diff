import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.ts';
import { transcriptFile } from './spool-helpers.ts';
import { Transcript, textOfTurn } from '../src/capture/transcript.ts';
import type { Said } from './spool-helpers.ts';

/** A turn's records, as the hook stamps them: the time cut to the second. */
const floored = (millis: number) => Math.floor(millis / 1000) * 1000;

/** The transcript's entries, read through `Transcript` (the way the spool does) from `ago` ms before now. */
function entriesOf(said: Said[], chunk?: number) {
  const session = 'sess-x';
  const file = transcriptFile(session, said);
  return { file, session, entries: Transcript.open(file, session, chunk)!.entriesSince(0) };
}

test('a turn’s prompt is the latest real prompt at its start, not the one before it or a background task’s notice', () => {
  const now = Date.now();
  // "what branch is this?", a 4 s answer, then "ok, commit it" 3 s later: the second prompt is within 10 s of the first
  const { entries } = entriesOf([
    { kind: 'human', ago: 20000, text: 'what branch is this?' },
    { kind: 'assistant', ago: 16000, text: 'main', message: 'm1' },
    { kind: 'notification', ago: 14000, text: 'bg-1' },
    { kind: 'human', ago: 13000, text: 'ok, commit it' },
    { kind: 'assistant', ago: 9000, text: 'Committed.', message: 'm2' },
  ]);
  // the hook runs 0.3 s after Claude Code writes the user line, and cuts its time to the second
  const start = floored(now - 13000 + 300);
  const end = floored(now - 9000 + 300);
  const said = textOfTurn(entries, start, end);
  assert.equal(said.prompt, 'ok, commit it');
  assert.equal(said.summary, 'Committed.');
  // the notification isn't a prompt, even when it is the latest line before the record
  const quiet = entriesOf([
    { kind: 'human', ago: 40000, text: 'run the build in the background' },
    { kind: 'notification', ago: 3000, text: 'bg-2' },
    { kind: 'assistant', ago: 2000, text: 'The build passed.', message: 'm3' },
  ]).entries;
  assert.equal(
    textOfTurn(quiet, floored(now - 3000 + 300), floored(now - 2000)).prompt,
    'run the build in the background',
    'the typed prompt, not <task-notification>…',
  );
  assert.deepEqual(
    quiet.map((entry) => entry.kind),
    ['prompt', 'assistant'],
  );
});

test('a prompt line stamped a little after its record (the record’s time is cut to the second) is still the turn’s', () => {
  const now = Date.now();
  const { entries } = entriesOf([
    { kind: 'prompt', ago: 30000, text: 'earlier' },
    { kind: 'assistant', ago: 29000, text: 'ok', message: 'm1' },
    { kind: 'prompt', ago: 5000, text: 'this one' },
    { kind: 'assistant', ago: 3000, text: 'done', message: 'm2' },
  ]);
  const stamp = now - 5000 - 700; // the record's time came out before the line (cut to the second)
  assert.equal(textOfTurn(entries, stamp, now).prompt, 'this one');
  // but not a prompt long after the record, which is the next turn's
  assert.equal(textOfTurn(entries, now - 9000, now - 8000).prompt, 'earlier');
  // and nothing recent in front of the record: no prompt, instead of an old one
  assert.equal(textOfTurn(entries, now + 600000, now + 601000).prompt, null);
});

test('a stopped turn’s last message is not taken from the next turn', () => {
  const now = Date.now();
  const { entries } = entriesOf([
    { kind: 'human', ago: 20000, text: 'first request' },
    { kind: 'assistant', ago: 17000, text: 'Starting on it.', message: 'm1' },
    { kind: 'interrupt', ago: 16500 },
    { kind: 'assistant', ago: 16200, text: 'Stopped, as asked.', message: 'm1b' },
    { kind: 'human', ago: 16000, text: 'second request' },
    // Claude answers the second prompt at once, inside the slack that a Stop record's time gets
    { kind: 'assistant', ago: 15500, text: 'Sure, doing that now.', message: 'm2' },
  ]);
  const start = floored(now - 20000 + 300);
  const nextPrompt = floored(now - 16000 + 300); // the record that ends the stopped turn
  const stopped = textOfTurn(entries, start, nextPrompt, { interrupted: true });
  assert.equal(stopped.prompt, 'first request');
  assert.equal(stopped.summary, 'Starting on it.');
  assert.equal(stopped.stopped, true);
  // the second turn, which ends at its own Stop
  const second = textOfTurn(entries, nextPrompt, floored(now - 15500 + 300));
  assert.equal(second.prompt, 'second request');
  assert.equal(second.summary, 'Sure, doing that now.');
});

test('a Stop with no prompt before it takes the first prompt after the previous Stop', () => {
  const now = Date.now();
  const { entries } = entriesOf([
    { kind: 'human', ago: 60000, text: 'a turn already made' },
    { kind: 'assistant', ago: 55000, text: 'done earlier', message: 'm0' },
    { kind: 'human', ago: 30000, text: 'the turn we are making' },
    { kind: 'assistant', ago: 20000, text: 'Made it.', message: 'm1' },
    { kind: 'human', ago: 5000, text: 'the next turn' },
  ]);
  const previousStop = floored(now - 55000 + 300);
  const said = textOfTurn(entries, previousStop, floored(now - 20000 + 300), { fromPrompt: false });
  assert.equal(said.prompt, 'the turn we are making');
  assert.equal(said.summary, 'Made it.');
});

/** The lines a turn writes, newest at the end, for the filler a long session has before it. */
const filler = (count: number, base: number) =>
  Array.from({ length: count }, (_, index) =>
    JSON.stringify({
      type: index % 2 ? 'assistant' : 'user',
      timestamp: new Date(base + index * 1000).toISOString(),
      ...(index % 2
        ? { message: { id: `m${index}`, content: [{ type: 'text', text: 'x'.repeat(900) }] } }
        : { origin: { kind: 'human' }, message: { content: 'y'.repeat(900) } }),
    }),
  ).join('\n');

test('a transcript over 64 MB still gives the prompt and summary, from reading only its tail', () => {
  const session = 'sess-big';
  const now = Date.now();
  const file = path.join(tmp('transcript-big'), `${session}.jsonl`);
  const old = filler(1000, now - 30 * 86400000);
  writeFileSync(file, '');
  for (let i = 0; i < 80; i++) {
    appendFileSync(file, old.replaceAll('"m', `"m${i}_`) + '\n'); // about 1.9 MB a time
  }
  assert.ok(statSync(file).size > 64 * 1024 * 1024);
  const small = transcriptFile(session, [
    { kind: 'human', ago: 3000, text: 'rename it' },
    { kind: 'assistant', ago: 1000, text: 'Renamed.', message: 'mlast' },
  ]);
  appendFileSync(file, readFileSync(small));
  const transcript = Transcript.open(file, session)!;
  const said = textOfTurn(
    transcript.entriesSince(floored(now - 3000 + 300) - 120000),
    floored(now - 3000 + 300),
    floored(now - 1000 + 300),
  );
  assert.equal(said.prompt, 'rename it');
  assert.equal(said.summary, 'Renamed.');
  assert.ok(
    transcript.bytesRead < 3 * 1024 * 1024,
    `read ${transcript.bytesRead} bytes of ${statSync(file).size}: a Stop costs only the recent part`,
  );
  // lines written after the first read are seen by the next one, without reading the file again
  const before = transcript.bytesRead;
  appendFileSync(
    file,
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: { id: 'mnew', content: [{ type: 'text', text: 'One more thing.' }] },
    }) + '\n',
  );
  const latest = transcript.entriesSince(now - 5000);
  assert.equal(latest[latest.length - 1].text, 'One more thing.');
  assert.ok(transcript.bytesRead - before < 4096);
});

test('reading backward in small chunks finds the same lines as one big read, across lines longer than a chunk', () => {
  const session = 'sess-chunks';
  const long = 'z'.repeat(5000);
  const said: Said[] = [
    { kind: 'human', ago: 90000, text: 'first ' + long },
    { kind: 'assistant', ago: 89000, text: 'héllo wörld ✓ ' + long, message: 'a1' },
    { kind: 'tool_result', ago: 88000 },
    { kind: 'meta', ago: 87000, text: 'ignored' },
    { kind: 'human', ago: 60000, text: 'second' },
    { kind: 'sidechain', ago: 50000, text: 'a subagent' },
    { kind: 'assistant', ago: 40000, text: 'part one', message: 'a2' },
    { kind: 'assistant', ago: 39000, text: 'part two', message: 'a2' },
    { kind: 'interrupt', ago: 30000 },
    { kind: 'human', ago: 20000, text: 'third' },
  ];
  const file = transcriptFile(session, said);
  const whole = Transcript.open(file, session, 1 << 24)!.entriesSince(0);
  assert.equal(whole.length, 7);
  for (const chunk of [1, 7, 64, 1000, 4096]) {
    const parts = Transcript.open(file, session, chunk)!.entriesSince(0);
    assert.deepEqual(parts, whole, `chunk of ${chunk} bytes`);
  }
  // a half-written last line waits, and is read once it has its end
  const last = JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { id: 'a3', content: [{ type: 'text', text: 'late' }] },
  });
  appendFileSync(file, last.slice(0, 30));
  const reader = Transcript.open(file, session, 64)!;
  assert.equal(reader.entriesSince(0).length, 7);
  appendFileSync(file, last.slice(30) + '\n');
  const done = reader.entriesSince(0);
  assert.equal(done.length, 8);
  assert.equal(done[7].text, 'late');
  // a line far over the limit is skipped, and the lines around it are kept
  const huge = JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { id: 'big', content: [{ type: 'text', text: 'q'.repeat(33 * 1024 * 1024) }] },
  });
  appendFileSync(file, huge + '\n');
  appendFileSync(
    file,
    JSON.stringify({
      type: 'user',
      origin: { kind: 'human' },
      timestamp: new Date().toISOString(),
      message: { content: 'after the huge line' },
    }) + '\n',
  );
  const skipped = Transcript.open(file, session, 1 << 20)!.entriesSince(0);
  assert.equal(skipped[skipped.length - 1].text, 'after the huge line');
  assert.equal(
    skipped.some((entry) => entry.text.startsWith('qqqq')),
    false,
    'the huge line is not kept',
  );
  assert.equal(skipped.length, 9, 'and what came before it is');
  assert.equal(skipped[0].text.startsWith('first '), true);
});
