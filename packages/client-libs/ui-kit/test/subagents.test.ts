import { test } from 'node:test';
import assert from 'node:assert/strict';
import { root, tick, fire } from './preact-env.ts';
const { html, render } = await import('/assets/preact.mjs');
const { SubagentList } = await import('../src/components/subagents.ts');

const NOW = Date.parse('2026-11-18T15:00:00Z');
const row = (key: string, state: 'running' | 'done', description: string) => ({
  key,
  name: null,
  description,
  agent_type: null,
  state,
  started_at: new Date(NOW - 4 * 60000).toISOString(),
  ended_at: state === 'done' ? new Date(NOW - 2 * 60000).toISOString() : null,
});

const draw = async (subagents: { rows: ReturnType<typeof row>[]; older: number }) => {
  render(html`<${SubagentList} subagents=${subagents} now=${NOW} />`, root);
  await tick();
};
const lines = () =>
  [...root.querySelectorAll('.ou-ui-subagent')].map((one) =>
    one.textContent!.replace(/\s+/g, ' ').trim(),
  );

test('running subagents show with how long they have run; finished ones are folded behind a count until opened', async () => {
  await draw({
    rows: [row('a', 'running', 'look at the logs'), row('b', 'done', 'fetch the page')],
    older: 0,
  });
  assert.deepEqual(lines(), ['● look at the logs running · 4m']);
  const toggle = root.querySelector('[data-subagents-toggle]') as HTMLElement;
  assert.match(toggle.textContent!, /1 finished/);
  fire(toggle, 'click');
  await tick();
  assert.deepEqual(lines(), ['● look at the logs running · 4m', '✓ fetch the page done · 2m']);
  assert.equal(root.querySelector('.ou-ui-subagent-done')?.getAttribute('title'), 'fetch the page');
});

test('finished ones past the cap are counted, never dropped silently; with none finished there is no fold', async () => {
  await draw({ rows: [row('b', 'done', 'x')], older: 4 });
  assert.match(
    root.querySelector('[data-subagents-toggle]')!.textContent!,
    /5 finished \(4 older not shown\)/,
  );
  await draw({ rows: [row('a', 'running', 'x')], older: 0 });
  assert.equal(root.querySelector('[data-subagents-toggle]'), null);
});
