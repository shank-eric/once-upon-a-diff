import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp, runCli } from './helpers.ts';
import {
  checkoutOf,
  localStory,
  prStory,
  reviewedBy,
} from '@once-upon-a-diff/state/test/board-fixtures';

test('once-upon reviewed marks a local story reviewed, --undo unmarks it, and a PR story or an unknown id is refused', async () => {
  const home = tmp('cli-reviewed');
  const widgets = checkoutOf('widgets', 'feat/x');
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7);
  localStory(home, 'local-feat-x', widgets, 'feat/x');
  const marked = await runCli(home, ['reviewed', 'local-feat-x']);
  assert.equal(marked.code, 0, marked.stderr);
  assert.match(marked.stdout, /local-feat-x marked reviewed/);
  assert.equal(reviewedBy(home, 'local-feat-x'), 'manual');
  const undone = await runCli(home, ['reviewed', 'local-feat-x', '--undo']);
  assert.equal(undone.code, 0, undone.stderr);
  assert.match(undone.stdout, /not reviewed/);
  assert.equal(
    reviewedBy(home, 'local-feat-x'),
    'manual',
    'an unmark is kept: {at: null, by: manual}',
  );
  const flagFirst = await runCli(home, ['reviewed', '--undo', 'local-feat-x']);
  assert.equal(flagFirst.code, 0, flagFirst.stderr);
  for (const args of [['reviewed'], ['reviewed', 'acme-widgets-7'], ['reviewed', 'nope']]) {
    assert.notEqual((await runCli(home, args)).code, 0, args.join(' '));
  }
});
