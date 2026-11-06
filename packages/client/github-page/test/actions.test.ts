import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareHead, intentOfClick, intentOfSubmit, type El } from '../src/actions.ts';

/** An element that knows what selectors it matches and who its parent is (closest walks up, as a browser's does). */
function el(
  label: string,
  matches: string[] = [],
  parent: El | null = null,
  extra: Partial<El> = {},
): El {
  const self: El & { matches: string[] } = {
    matches,
    textContent: label,
    getAttribute: () => null,
    closest(selector) {
      const wanted = selector.split(',').map((one) => one.trim());
      for (let node: (El & { matches?: string[] }) | null = self; node;) {
        if (node.matches?.some((one) => wanted.includes(one))) {
          return node;
        }
        node = (node as unknown as { parent: typeof node }).parent;
      }
      return null;
    },
    ...extra,
  };
  (self as unknown as { parent: El | null }).parent = parent;
  return self;
}
const button = (label: string, parent: El | null = null) => el(label, ['button'], parent);
const PR_PATH = '/Acme/Widgets/pull/42';

test('the buttons that act on a PR_PATH, by their whole text, on that PR_PATH’s pages', () => {
  const cases: [string, string, string][] = [
    ['Submit review', `${PR_PATH}/files`, 'review'],
    ['Submit review', `${PR_PATH}/changes`, 'review'],
    ['Merge pull request', PR_PATH, 'merge'],
    ['  Confirm   merge ', PR_PATH, 'merge'],
    ['Squash and merge', PR_PATH, 'merge'],
    ['Confirm squash and merge', PR_PATH, 'merge'],
    ['Confirm rebase and merge', PR_PATH, 'merge'],
    ['Ready for review', PR_PATH, 'ready'],
    ['Convert to draft', PR_PATH, 'ready'],
    ['Close pull request', PR_PATH, 'close'],
    ['Reopen pull request', PR_PATH, 'close'],
  ];
  for (const [label, pathname, reason] of cases) {
    assert.deepEqual(
      intentOfClick(button(label), pathname),
      { reason, repo: 'Acme/Widgets', number: 42 },
      `${label} on ${pathname}`,
    );
  }
});

test('anything that is not a whole-text match on a real control is nothing', () => {
  for (const label of [
    'Approve',
    'Merge',
    'Merge conflicts',
    'Submit review and then merge',
    'Please merge pull request',
    'Squash and merge later',
    'Comment',
    '',
  ]) {
    assert.equal(intentOfClick(button(label), PR_PATH), null, label);
  }
  // text that is not in a control (a paragraph, a link), and a control outside a PR_PATH page
  assert.equal(intentOfClick(el('Merge pull request'), PR_PATH), null);
  assert.equal(intentOfClick(button('Merge pull request'), '/Acme/Widgets/pulls'), null);
  assert.equal(intentOfClick(button('Merge pull request'), '/Acme/Widgets/issues/3'), null);
  assert.equal(intentOfClick(null, PR_PATH), null);
  // a role=button and an input's label count; the clicked child of a button counts as its button
  assert.equal(intentOfClick(el('Submit review', ['[role="button"]']), PR_PATH)?.reason, 'review');
  assert.equal(
    intentOfClick(el('', ['input[type="submit"]'], null, { value: 'Merge pull request' }), PR_PATH)
      ?.reason,
    'merge',
  );
  assert.equal(
    intentOfClick(el('icon', [], button('Close pull request')), PR_PATH)?.reason,
    'close',
  );
});

test('a button’s label is its visible text, not its value attribute', () => {
  const merge = el('Merge pull request', ['button'], null, { value: 'merge-method-1' });
  assert.equal(intentOfClick(merge, PR_PATH)?.reason, 'merge');
  const aria = el('', ['button'], null, {
    getAttribute: (name) => (name === 'aria-label' ? 'Submit review' : null),
  });
  assert.equal(intentOfClick(aria, PR_PATH)?.reason, 'review');
});

test('a "button" inside rendered markdown (a PR_PATH description or a comment) is nothing', () => {
  for (const klass of ['.markdown-body', '.comment-body', '.js-comment-body']) {
    const markdown = el('', [klass]);
    assert.equal(intentOfClick(button('Merge pull request', markdown), PR_PATH), null, klass);
    assert.equal(
      intentOfClick(el('Merge pull request', ['[role="button"]'], markdown), PR_PATH),
      null,
      klass,
    );
  }
});

test('Create pull request is for a compare page, and names the branch from its URL', () => {
  const click = (pathname: string) => intentOfClick(button('Create pull request'), pathname);
  assert.deepEqual(click('/Acme/Widgets/compare/main...fix-it'), {
    reason: 'open',
    repo: 'Acme/Widgets',
    branch: 'fix-it',
  });
  assert.equal(click(PR_PATH), null, 'not on a PR_PATH');
  assert.equal(
    intentOfClick(button('Create draft pull request'), '/Acme/Widgets/compare/fix-it')?.branch,
    'fix-it',
  );
  // a fork's branch is not a branch of this repo: no branch, the number comes from the page it lands on
  assert.deepEqual(click('/Acme/Widgets/compare/main...octocat:fix-it'), {
    reason: 'open',
    repo: 'Acme/Widgets',
  });
});

test('every compare form: head alone, two or three dots, owner:head, owner:repo:head, slashes, encoding, ?expand', () => {
  const head = (pathname: string) => compareHead(pathname)?.branch;
  assert.equal(head('/Acme/Widgets/compare/fix-it'), 'fix-it');
  assert.equal(head('/Acme/Widgets/compare/main...fix-it'), 'fix-it');
  assert.equal(head('/Acme/Widgets/compare/main..fix-it'), 'fix-it');
  assert.equal(head('/Acme/Widgets/compare/main...fix-it/'), 'fix-it');
  assert.equal(head('/Acme/Widgets/compare/main...feature/x'), 'feature/x', 'an unencoded slash');
  assert.equal(
    head('/Acme/Widgets/compare/release/1.2...feature/x'),
    'feature/x',
    'and in the base',
  );
  assert.equal(head('/Acme/Widgets/compare/main...feature%2Fx'), 'feature/x', 'an encoded one');
  assert.equal(head('/Acme/Widgets/compare/feature/x'), 'feature/x', 'no base');
  assert.equal(
    head('/Acme/Widgets/compare/main...Acme:fix-it'),
    'fix-it',
    'owner:head, the same owner',
  );
  assert.equal(head('/Acme/Widgets/compare/main...acme:fix-it'), 'fix-it', 'case does not matter');
  assert.equal(head('/Acme/Widgets/compare/main...Acme:Widgets:fix-it'), 'fix-it');
  assert.equal(
    head('/Acme/Widgets/compare/main...Acme:Other:fix-it'),
    null,
    'another repo of the owner',
  );
  assert.equal(head('/Acme/Widgets/compare/main...octocat:fix-it'), null, 'a fork');
  assert.equal(
    head('/Acme/Widgets/compare/main...octocat:Widgets:fix-it'),
    null,
    'a fork, owner:repo:head',
  );
  assert.equal(head('/Acme/Widgets/compare/main...%E0%A4%A'), null, 'a bad escape');
  assert.equal(head('/Acme/Widgets/pull/new/fix-it'), 'fix-it');
  assert.equal(compareHead('/Acme/Widgets/compare/main...fix-it')?.repo, 'Acme/Widgets');
  assert.equal(compareHead('/Acme/Widgets/pull/42'), null);
  assert.equal(compareHead('/Acme/Widgets/compare'), null);
});

test('a form submit: a review’s form, or the Create pull request form', () => {
  assert.deepEqual(intentOfSubmit('/Acme/Widgets/pull/42/reviews', `${PR_PATH}/files`), {
    reason: 'review',
    repo: 'Acme/Widgets',
    number: 42,
  });
  assert.deepEqual(
    intentOfSubmit('/Acme/Widgets/pull/create', '/Acme/Widgets/compare/main...fix-it'),
    { reason: 'open', repo: 'Acme/Widgets', branch: 'fix-it' },
  );
  assert.equal(intentOfSubmit('/Acme/Widgets/pull/create', PR_PATH), null, 'not on a compare page');
  assert.equal(intentOfSubmit('/Acme/Widgets/pull/42/comments', PR_PATH), null);
  assert.equal(intentOfSubmit('/search', '/search'), null);
});
