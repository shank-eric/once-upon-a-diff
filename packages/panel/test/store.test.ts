import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createView } from '../src/store.ts';

test('update draws at once, so the DOM is current when it returns', () => {
  let drawn = 0;
  const view = createView(() => void drawn++);
  view.update();
  view.update();
  assert.equal(drawn, 2);
});

test('an update asked for during a draw does not nest: it draws once more when the first is done', () => {
  const log: string[] = [];
  let depth = 0;
  let nested = 0;
  let asked = false;
  const view = createView(() => {
    depth++;
    nested = Math.max(nested, depth);
    log.push('draw');
    if (!asked) {
      asked = true;
      view.update(); // a part publishing from something the draw runs
      log.push('asked');
    }
    depth--;
  });
  view.update();
  assert.equal(nested, 1, 'never a draw inside a draw');
  assert.deepEqual(log, ['draw', 'asked', 'draw']);
});

test('a part that keeps asking is stopped, and the next update works', () => {
  let drawn = 0;
  const view = createView(() => {
    drawn++;
    view.update();
  });
  view.update();
  assert.equal(drawn, 10, 'a loop ends after its rounds');
  drawn = 0;
  let once = true;
  const calm = createView(() => {
    drawn++;
    if (once) {
      once = false;
      calm.update();
    }
  });
  calm.update();
  assert.equal(drawn, 2);
});

test('a draw that throws leaves the view able to draw again', () => {
  let fail = true;
  let drawn = 0;
  const view = createView(() => {
    drawn++;
    if (fail) {
      throw new Error('boom');
    }
  });
  assert.throws(() => view.update(), /boom/);
  fail = false;
  view.update();
  assert.equal(drawn, 2);
});
