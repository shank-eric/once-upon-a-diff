import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askWhoHtml, healthChecks, type Health } from '../src/components/status-light.ts';

const STORY = 'acme-widgets-7';

test('the line under the Ask box says who answers, by repo or by story, and offers Start listening only when the host can', () => {
  // just what askWhoHtml reads of the status light's health
  const result = {
    level: 'ok' as const,
    prompt: '/once-upon-listen acme/widgets',
    storyPrompt: { prompt: `/once-upon-listen --story ${STORY}` },
  };
  const byRepo = String(
    askWhoHtml(
      {
        ...result,
        answering: { consumer: 'repo-acme-widgets', scope: 'repo' },
      } as Health,
      true,
    ),
  );
  assert.match(byRepo, /Answered by <b>repo-acme-widgets<\/b> \(listening for the whole repo\)/);
  assert.match(byRepo, /Start listening for this story/);
  const byStory = String(
    askWhoHtml(
      {
        ...result,
        answering: { consumer: 'api-10', scope: 'story' },
      } as Health,
      true,
    ),
  );
  assert.match(byStory, /Answered by <b>api-10<\/b>, the session listening for this story/);
  assert.doesNotMatch(byStory, /Start listening/);
  assert.match(
    String(askWhoHtml({ ...result, answering: null } as Health, true)),
    /Start listening for this story/,
  );
  assert.equal(String(askWhoHtml({ level: 'error' } as Health)), '');
});

test('the line under the Ask box names the agent, with or without a relay', () => {
  const health = (extra: Partial<Health>): Health => ({
    level: 'ok',
    checks: [],
    listening: true,
    ...extra,
  });
  const relayed = String(
    askWhoHtml(
      health({
        answering: { consumer: 'story-x', scope: 'story', agent: 'ou-fix-cache' },
        agent: 'ou-fix-cache',
      }),
    ),
  );
  assert.match(
    relayed,
    /Questions go to <b>ou-fix-cache<\/b>, the agent that built this story, through <b>story-x<\/b>/,
  );
  // a repo wait in the owner session relays: the panel names the agent, not the repo listener, as who answers
  const repoRelay = String(
    askWhoHtml(
      health({
        answering: { consumer: 'repo-acme', scope: 'repo', agent: 'ou-fix-cache' },
        agent: 'ou-fix-cache',
      }),
    ),
  );
  assert.match(repoRelay, /Questions go to <b>ou-fix-cache<\/b>.*through <b>repo-acme<\/b>/);
  // not relayed yet: only the session that launched the agent can reach it, so no Start button and no copy button, only the line to run by hand as plain text
  const waiting = String(
    askWhoHtml(
      health({
        answering: { consumer: 'repo-acme', scope: 'repo' },
        agent: 'ou-fix-cache',
        prompt: '/once-upon-listen acme/widgets',
        storyPrompt: { prompt: `/once-upon-listen --story ${STORY}` },
      }),
      true,
    ),
  );
  assert.match(waiting, /ou-fix-cache<\/b> built this story/);
  assert.match(waiting, /Only the Claude session that launched it can pass/);
  assert.match(waiting, /Until it does, <b>repo-acme<\/b> answers/);
  assert.doesNotMatch(waiting, /ou-startstory/);
  assert.doesNotMatch(waiting, /Copy prompt|ou-copystory|<button/);
  assert.match(
    waiting,
    new RegExp(
      `To start that, run <code>/once-upon-listen --story ${STORY}</code> in the session that launched ou-fix-cache`,
    ),
  );
  const plain = String(askWhoHtml(health({ answering: { consumer: 'story-x', scope: 'story' } })));
  assert.match(plain, /Answered by <b>story-x<\/b>, the session listening for this story/);
  // the status light's own answer carries the agent through
  assert.equal(
    healthChecks({
      bridge: { version: '1' },
      story: { ok: true, id: STORY },
      listening: { ok: true, agent: 'ou-fix-cache' },
    }).agent,
    'ou-fix-cache',
  );
});
