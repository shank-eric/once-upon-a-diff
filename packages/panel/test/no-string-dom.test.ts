/*
 * The panel draws with Preact, so a part that writes into the DOM by hand is either a host node (the page's file blocks, the
 * document), a gesture that would otherwise redraw the panel at every pointer move, or the frame itself. This pins where the
 * hand writes are: a new one anywhere else fails, and a file's count can only fall. Each write counts, not each line, so a second
 * write beside one that is allowed fails too. The patterns are checked against a table of probes (one per way of writing, and a few
 * reads that are not writes), so the check cannot lose a way without a test saying so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { code, files, writesIn } from '@once-upon-a-diff/test-kit/dom-writes';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');

/** file (under src): [how many hand writes, why]. A count can only fall. */
const ALLOWED: Record<string, [number, string]> = {
  'shell/shell.ts': [
    21,
    'the frame: the host element and its stylesheets, the width grip’s drag (its classes; the pointer work is ui-kit’s createDrag), the root’s classes and key listener, docking the page',
  ],
  'shell/overlay.ts': [1, 'the window’s focus'],
  'ask/chat-dock.ts': [
    4,
    'the dock’s height drag (a CSS property and a class written at each pointer move, so it is not a redraw; the pointer work is ui-kit’s createDrag) and the window’s resize',
  ],
  'ask/questions.ts': [
    3,
    'the tab showing again, and the Ask box’s text (an uncontrolled textarea: set from the saved draft, cleared after a send)',
  ],
  'reading/filter.ts': [11, 'the page’s file blocks (hidden marks), its hash and its mutations'],
  'reading/navigation.ts': [1, 'the page’s scroll'],
  'reading/reading.ts': [2, 'the page’s visibility and unload'],
  'reading/scroll.ts': [4, 'the page’s scrolling and highlight'],
  'reading/viewed.ts': [2, 'the page’s Viewed toggles'],
  'components/status-light-part.ts': [
    1,
    'a prop set on a parsed element in a markup hook (the details box), not a node',
  ],
  'fixes/working.ts': [2, 'the page’s dimmed blocks (host nodes)'],
};

test('the panel writes into the DOM by hand only where it says it does', () => {
  const found: Record<string, number> = {};
  for (const file of files(SRC)) {
    const count = writesIn(readFileSync(file, 'utf8'));
    if (count) {
      found[path.relative(SRC, file)] = count;
    }
  }
  const pinned = Object.fromEntries(
    Object.entries(ALLOWED)
      .filter(([, [count]]) => count > 0)
      .map(([file, [count]]) => [file, count]),
  );
  assert.deepEqual(found, pinned);
});

test('every way of writing is matched, and a read is not', () => {
  const writes = [
    'setHtml(el, x)',
    'insertHtml(el, "beforeend", x)',
    'el.innerHTML = x',
    'el.outerHTML = x',
    'el.innerText = x',
    'el.insertAdjacentHTML("beforeend", x)',
    'el.insertAdjacentElement("afterbegin", y)',
    'el.textContent = x',
    'el.title = x',
    'input.value = x',
    'box.checked = true',
    'details.open = true',
    'el.hidden = true',
    'button.disabled = true',
    'el.className = "x"',
    'el.id = "x"',
    'a.href = x',
    'img.src = x',
    'el.style.setProperty("--x", "1")',
    'el.style.height = "3px"',
    'el.style = x',
    'el.dataset.label = x',
    'el.onclick = fn',
    'form.onsubmit = fn',
    'el.setAttribute("x", "y")',
    'el.removeAttribute("x")',
    'el.toggleAttribute("x")',
    'el.classList.add("x")',
    'el.classList.remove("x")',
    'el.classList.toggle("x", on)',
    'el.addEventListener("click", fn)',
    'el.replaceChildren(a, b)',
    'el.append(a)',
    'el.prepend(a)',
    'el.before(a)',
    'el.after(a)',
    'el.appendChild(a)',
    'el.insertBefore(a, b)',
    'el.removeChild(a)',
    'el.replaceWith(a)',
    'el.remove()',
    'document.createElement("div")',
    'document.createTextNode("x")',
  ];
  for (const line of writes) {
    assert.equal(writesIn(line), 1, `${line} is a write`);
  }
  assert.equal(writesIn('el.title = x; el.value = y'), 2, 'two writes on a line are two');
  const reads = [
    'const t = el.title;',
    'if (input.value === "x") {}',
    'const all = el.querySelectorAll("a");',
    'el.classList.contains("x")',
    'const a = el.getAttribute("x");',
    'el.hasAttribute("x")',
    'const text = el.textContent;',
    'a.closest("form")',
    'el.removeEventListener("click", fn)',
    '// el.innerHTML = x',
    '/* el.remove() */',
    'if (el.hidden == null) {}',
  ];
  for (const line of reads) {
    assert.equal(writesIn(line), 0, `${line} is not a write`);
  }
});

test('nothing in the panel reads the old data-html cache or finds a control by its attribute where the drafts, the fixes, the rebuild and the body draw them', () => {
  for (const file of files(SRC)) {
    const source = code(readFileSync(file, 'utf8'));
    assert.ok(!/data-html/.test(source), `${path.relative(SRC, file)} still names data-html`);
    if (/^(drafts|fixes|rebuild)\//.test(path.relative(SRC, file)) || /body\.ts$/.test(file)) {
      assert.ok(
        !/closest\(\s*['"`]\[?(data-|\.ou-)/.test(source),
        `${path.relative(SRC, file)} finds a control by its attribute: give the element its own handler`,
      );
    }
  }
});
