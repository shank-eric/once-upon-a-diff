import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document, root, tick, fire, window } from './preact-env.ts';
const { html, render } = await import('/assets/preact.mjs');
const { MenuButton } = await import('../src/components/menu.ts');

const items = [
  { value: 'a', label: 'Alpha', detail: 'idle 5m' },
  { value: 'b', label: 'Beta', checked: true },
  { value: 'c', label: 'Gamma' },
];
const picked: string[] = [];
const draw = async (props: Record<string, unknown> = {}, text = 'Pick') => {
  render(
    html`<${MenuButton} items=${items} onPick=${(value: string) => picked.push(value)} label="Sessions" data-menu title="Choose one" ...${props}>${text}</${MenuButton}>`,
    root,
  );
  await tick();
};
const button = () => root.querySelector('button') as HTMLButtonElement;
const menu = () => document.querySelector('.ou-menu') as HTMLElement | null;
const rows = () => [...document.querySelectorAll('.ou-menu-item')] as HTMLElement[];
const labels = () => rows().map((item) => item.textContent?.replace(/\s+/g, ' ').trim());
const click = async (target: Element) => {
  fire(target, 'click');
  await tick();
};
const press = async (key: string) => {
  const event = fire(document as unknown as Element, 'keydown', { key });
  await tick();
  return event;
};
const focused = () => rows().indexOf(document.activeElement as HTMLElement);

test('a MenuButton is a button that says it opens a menu, with the host’s props and text, and nothing is open yet', async () => {
  await draw({ class: 'chip' });
  assert.equal(button().textContent, 'Pick');
  assert.equal(button().getAttribute('type'), 'button');
  assert.equal(button().getAttribute('aria-haspopup'), 'menu');
  assert.equal(button().getAttribute('aria-expanded'), 'false');
  assert.equal(button().className, 'chip');
  assert.equal(button().title, 'Choose one');
  assert.ok(button().hasAttribute('data-menu'));
  assert.equal(menu(), null);
});

test('it opens a menu of the items with their details and the checked one ticked, focused, under the body', async () => {
  await draw();
  await click(button());
  assert.equal(menu()?.getAttribute('role'), 'menu');
  assert.equal(menu()?.getAttribute('aria-label'), 'Sessions');
  assert.equal(
    menu()?.parentElement?.parentElement,
    document.body,
    'in a root of its own at the end of the body',
  );
  assert.deepEqual(labels(), ['Alphaidle 5m', '✓Beta', 'Gamma']);
  assert.ok(rows().every((item) => item.getAttribute('role') === 'menuitem'));
  assert.ok(rows().every((item) => item.getAttribute('tabindex') === '-1'));
  assert.equal(button().getAttribute('aria-expanded'), 'true');
  assert.equal(focused(), 1, 'the checked item has the focus');
  assert.equal(document.querySelectorAll('.ou-menu-check[aria-hidden="true"]').length, 3);
  await click(button());
});

test('the arrows, Home and End move the focus and wrap; a pick says its value, closes the menu and returns the focus', async () => {
  picked.length = 0;
  await draw({ items: items.map((one) => ({ ...one, checked: false })) });
  await click(button());
  assert.equal(focused(), 0, 'with none checked, the first');
  await press('ArrowDown');
  assert.equal(focused(), 1);
  await press('End');
  assert.equal(focused(), 2);
  await press('ArrowDown');
  assert.equal(focused(), 0, 'down from the last wraps');
  await press('ArrowUp');
  assert.equal(focused(), 2, 'up from the first wraps');
  await press('Home');
  assert.equal(focused(), 0);
  await click(rows()[1]);
  assert.deepEqual(picked, ['b']);
  assert.equal(menu(), null);
  assert.equal(button().getAttribute('aria-expanded'), 'false');
  assert.ok(document.activeElement === button());
});

test('Escape and Tab close it, mark the key and give the focus back to the button', async () => {
  await draw();
  for (const key of ['Escape', 'Tab']) {
    await click(button());
    assert.ok(menu());
    const event = await press(key);
    assert.ok(event.defaultPrevented);
    assert.equal(menu(), null);
    assert.equal(button().getAttribute('aria-expanded'), 'false');
    assert.ok(document.activeElement === button(), `${key} returns the focus`);
  }
});

test('a pointer down elsewhere, or the page resizing or scrolling (not the menu’s own), closes it; a pointer down on the button does not', async () => {
  await draw();
  await click(button());
  fire(button(), 'pointerdown');
  await tick();
  assert.ok(menu(), 'on the button: its click toggles');
  fire(menu() as Element, 'pointerdown');
  await tick();
  assert.ok(menu(), 'inside the menu: it stays');
  fire(document.body as unknown as Element, 'pointerdown');
  await tick();
  assert.equal(menu(), null, 'elsewhere: it closes');
  await click(button());
  fire(window as unknown as Element, 'resize');
  await tick();
  assert.equal(menu(), null, 'a resize closes it');
  await click(button());
  fire(menu() as Element, 'scroll');
  fire(rows()[1], 'scroll');
  await tick();
  assert.ok(menu(), 'the menu’s own scroll (or an item’s) does not close it');
  fire(document.body as unknown as Element, 'scroll');
  await tick();
  assert.equal(menu(), null, 'a scroll of the page or an ancestor closes it');
  assert.equal(button().getAttribute('aria-expanded'), 'false');
});

test('a second click on the button closes it', async () => {
  await draw();
  await click(button());
  await click(button());
  assert.equal(menu(), null);
  assert.equal(button().getAttribute('aria-expanded'), 'false');
});

test('a function for items makes the list when the menu opens, and onOpen can keep it closed', async () => {
  let made = 0;
  let allow = false;
  await draw({
    items: () => {
      made++;
      return [{ value: 'x', label: `Made ${made}` }];
    },
    onOpen: () => allow,
  });
  assert.equal(made, 0, 'nothing is made until it opens');
  await click(button());
  assert.equal(menu(), null, 'onOpen said false');
  assert.equal(made, 0);
  assert.equal(button().getAttribute('aria-expanded'), 'false');
  allow = true;
  await click(button());
  assert.deepEqual(labels(), ['Made 1']);
  await click(button());
  await click(button());
  assert.deepEqual(labels(), ['Made 2'], 'a list as it is each time it opens');
  await click(button());
});

test('only one menu is open at a time', async () => {
  render(
    html`<div><${MenuButton} id="one" items=${items} onPick=${() => {}} label="First">One</${MenuButton}><${MenuButton} id="two" items=${items} onPick=${() => {}} label="Second">Two</${MenuButton}></div>`,
    root,
  );
  await tick();
  const [one, two] = [...root.querySelectorAll('button')] as HTMLElement[];
  await click(one);
  assert.equal(menu()?.getAttribute('aria-label'), 'First');
  await click(two);
  assert.equal(document.querySelectorAll('.ou-menu').length, 1);
  assert.equal(menu()?.getAttribute('aria-label'), 'Second');
  assert.equal(one.getAttribute('aria-expanded'), 'false');
  assert.equal(two.getAttribute('aria-expanded'), 'true');
  await click(two);
});

test('a button taken off the page takes its open menu with it', async () => {
  await draw();
  await click(button());
  assert.ok(menu());
  render(null, root);
  assert.equal(menu(), null);
  assert.equal(document.body.querySelectorAll('.ou-menu').length, 0);
});

test('it sits under the button inside the window, and flips above when there is no room below', async () => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  const rect = proto.getBoundingClientRect;
  Object.defineProperty(proto, 'offsetWidth', { get: () => 200, configurable: true });
  Object.defineProperty(proto, 'offsetHeight', { get: () => 150, configurable: true });
  try {
    await draw();
    const anchorAt = (box: { left: number; top: number; bottom: number }) => {
      proto.getBoundingClientRect = () => box;
    };
    // window.innerWidth is 1000; innerHeight is not set by the DOM kit, so set it
    Object.assign(window, { innerHeight: 768 });
    anchorAt({ left: 40, top: 10, bottom: 30 });
    await click(button());
    assert.equal(menu()?.style.left, '40px');
    assert.equal(menu()?.style.top, '34px', 'under the button, 4px off');
    await click(button());
    anchorAt({ left: 900, top: 700, bottom: 720 });
    await click(button());
    assert.equal(menu()?.style.left, '792px', 'kept 8px inside the right edge');
    assert.equal(menu()?.style.top, '546px', 'above the button: no room below');
    await click(button());
  } finally {
    proto.getBoundingClientRect = rect;
    delete proto.offsetWidth;
    delete proto.offsetHeight;
  }
});
