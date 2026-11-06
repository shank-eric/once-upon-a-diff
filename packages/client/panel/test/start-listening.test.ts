import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askHintHtml, askWhoHtml, type Health } from '../src/components/status-light.ts';

test('the story line has Start listening only where the host can, and never a Copy prompt button', () => {
  const result = {
    level: 'ok' as const,
    prompt: '/once-upon-listen acme/widgets',
    storyPrompt: { prompt: '/once-upon-listen --story acme-widgets-7' },
    answering: null,
  } as Health;
  const without = String(askWhoHtml(result));
  assert.doesNotMatch(without, /Start listening|Copy prompt/);
  const withStart = String(askWhoHtml(result, true));
  assert.match(withStart, /class="ou-startstory"[^>]*>Start listening for this story</);
  assert.match(withStart, /class="ou-startnote"/);
  assert.doesNotMatch(withStart, /Copy prompt|ou-copystory|ou-prompt/);
  assert.doesNotMatch(
    String(askWhoHtml({ ...result, answering: { consumer: 'x', scope: 'story' } } as Health, true)),
    /Start listening/,
    'a story that has its own listener needs none',
  );
});

test('the Ask hint has Start listening when the host can, the line to type, and never a Copy prompt button', () => {
  const result = {
    level: 'warn' as const,
    prompt: '/once-upon-listen acme/widgets',
    details: 'once-upon wait --repo acme/widgets',
    repo: 'acme/widgets',
    checkout: '~/Development/widgets',
    checks: [],
  } as unknown as Health;
  const withStart = String(askHintHtml(result, true));
  assert.match(withStart, /class="ou-startlisten"[^>]*>Start listening</);
  assert.match(withStart, /class="ou-startnote"/);
  assert.match(withStart, /<code>\/once-upon-listen acme\/widgets<\/code>/);
  assert.match(withStart, /Start Claude Code in <code>~\/Development\/widgets<\/code>/);
  assert.doesNotMatch(withStart, /Copy prompt|ou-copyprompt|ou-prompt"/);
  // the note opens under the button, not in the middle of the sentence about typing the line yourself
  assert.ok(withStart.indexOf('ou-startnote') < withStart.indexOf('No idle session to type into?'));
  assert.ok(withStart.indexOf('Start listening</button>') < withStart.indexOf('ou-startnote'));
  assert.doesNotMatch(String(askHintHtml(result, false)), /Start listening|Copy prompt/);
});
