import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document, root, tick, fire } from './preact-env.ts';
const { html, render } = await import('/assets/preact.mjs');
const { CopyButton, useCopied } = await import('../src/components/copy-button.ts');

const written: string[] = [];
let mode: 'ok' | 'refused' | 'none' = 'ok';
Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  get: () =>
    mode === 'none'
      ? undefined
      : {
          writeText: async (text: string) => {
            written.push(text);
            if (mode === 'refused') {
              throw new Error('no');
            }
          },
        },
});

const button = () => root.querySelector('button') as HTMLButtonElement;
const wait = (delay: number) => new Promise((resolve) => setTimeout(resolve, delay));

test('a click copies the text once and the label says Copied', async () => {
  written.length = 0;
  mode = 'ok';
  render(
    html`<${CopyButton} text="notes.md" class="ou-ui-copy" title="Copy it" attrs=${{ 'data-copy-notes': true }}>Copy</${CopyButton}>`,
    root,
  );
  assert.equal(button().textContent, 'Copy');
  assert.equal(button().getAttribute('title'), 'Copy it');
  assert.equal(button().className, 'ou-ui-copy');
  assert.ok(button().hasAttribute('data-copy-notes'));
  fire(button(), 'click');
  await tick();
  assert.deepEqual(written, ['notes.md']);
  assert.equal(button().textContent, 'Copied');
  render(null, root);
});

test('when the clipboard says no, onFailed runs and its answer is the label; no answer, no label', async () => {
  mode = 'refused';
  let failed = 0;
  render(
    html`<${CopyButton} text="x" onFailed=${() => {
      failed++;
      return 'Select and copy';
    }}>Copy</${CopyButton}>`,
    root,
  );
  fire(button(), 'click');
  await tick();
  assert.equal(failed, 1);
  assert.equal(button().textContent, 'Select and copy');
  render(null, root);
  render(html`<${CopyButton} text="x" onFailed=${() => void failed++}>Copy</${CopyButton}>`, root);
  fire(button(), 'click');
  await tick();
  assert.equal(failed, 2);
  assert.equal(button().textContent, 'Copy', 'no answer, no label');
  render(null, root);
  mode = 'none';
  render(html`<${CopyButton} text="y">Copy</${CopyButton}>`, root);
  fire(button(), 'click');
  await tick();
  assert.equal(button().textContent, 'Copy', 'no clipboard and no fallback: nothing to say');
  render(null, root);
});

test('the label goes back by itself, and a timer left over is dropped when the button goes', async () => {
  function Probe(props: { ms: number }) {
    const [label, say] = useCopied(props.ms);
    return html`<button type="button" onClick=${() => say('Copied')}>${label ?? 'Copy'}</button>`;
  }
  render(html`<${Probe} ms=${30} />`, root);
  fire(button(), 'click');
  await tick();
  assert.equal(button().textContent, 'Copied');
  await wait(60);
  assert.equal(button().textContent, 'Copy');
  fire(button(), 'click');
  await tick();
  render(null, root);
  await wait(60);
  assert.equal(document.querySelectorAll('button').length, 0);
});
