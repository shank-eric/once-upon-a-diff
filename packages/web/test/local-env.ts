/*
 * The local page's modules with no browser: the DOM test env, the page's address and boot block (page.ts reads them when it
 * loads), and a fake bridge behind fetch. A test says what each route answers with `reply`, and reads what was asked from
 * `requests`. Import it first, then import the modules under test.
 */
import { document, window, tick, fire } from './dom-env.ts';

// Preact runs effects after the next frame, or after 100 ms where there is no requestAnimationFrame
Object.assign(globalThis, {
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
// the page sends window events (`new Event`): linkedom's window takes its own Event, not Node's
Object.assign(globalThis, { Event: window.Event });
Object.assign(globalThis, { location: { hash: '#key=k', href: 'http://localhost/#key=k' } });
// linkedom has no scrolling: the page asks to scroll, and a test that cares replaces this
Object.assign(window, { scrollTo: () => {}, scrollY: 0 });
const boot = document.createElement('script');
boot.id = 'ou-local-boot';
boot.textContent = JSON.stringify({ story: 'story-1' });
document.body.appendChild(boot);

export { document, window, tick, fire };

export interface Asked {
  method: string;
  path: string;
  body?: unknown;
}
export const requests: Asked[] = [];

/** What a route answers with: a value, or a function that returns one or throws a { status, error } refusal. */
type Answer = unknown | (() => unknown | Promise<unknown>);
const answers = new Map<string, Answer>();

/** Sets the answer for a call, as 'GET push' (the story's own routes, under /api/stories/story-1/). */
export function reply(call: string, answer: Answer) {
  answers.set(call, answer);
}

/** Every call that was asked on a route, in order. */
export const askedOn = (call: string) => {
  const [method, what] = call.split(' ');
  return requests.filter((one) => one.method === method && one.path.endsWith(`/${what}`));
};

Object.assign(globalThis, {
  fetch: async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    requests.push({ method, path, body: init?.body ? JSON.parse(init.body) : undefined });
    const what = path.replace('/api/stories/story-1/', '');
    const answer = answers.get(`${method} ${what}`);
    try {
      const body = typeof answer === 'function' ? await (answer as () => unknown)() : answer;
      return { ok: true, status: 200, json: async () => body ?? {} };
    } catch (err) {
      const { status = 500, error = (err as Error).message } = err as {
        status?: number;
        error?: string;
      };
      return { ok: false, status, json: async () => ({ error }) };
    }
  },
});

export const refuse =
  (error: string, status = 500) =>
  () => {
    throw { status, error };
  };

const { render, html } = await import('/assets/preact.mjs');
const { store } = await import('../public/local/store.ts');
const { DialogHost } = await import('../public/local/ship/dialogs.ts');
const { openDialog, closeDialog } = await import('../public/local/actions.ts');
// the page's boxes, drawn from the store as the page draws them (the rest of the page is not drawn here)
const dialogs = document.createElement('div');
document.body.appendChild(dialogs);
store.attach((state) =>
  render(
    state.story ? html`<${DialogHost} story=${state.story} dialog=${state.ship.dialog} />` : null,
    dialogs,
  ),
);
export { store };
/** The story the page holds. */
export const current = () => store.get().story as never as ReturnType<typeof story>;
export const setStory = (next: ReturnType<typeof story>) => {
  store.set({ story: next as never });
  store.flush();
};
/** Opens a box, drawn now. */
export const openBox = (name: 'push' | 'push-ahead' | 'pr') => {
  openDialog(name);
  store.flush();
};
/** Closes the box, as the page does when it says it closed. */
export const closeBox = () => {
  closeDialog();
  store.flush();
};

/** The open dialog, if any. */
export const box = () => document.getElementById('ou-local-pr-box') as HTMLElement | null;
export const text = () => (box()?.textContent ?? '').replace(/\s+/g, ' ').trim();
export const button = (label: string) =>
  [...(box()?.querySelectorAll('button') ?? [])].find(
    (one) => (one.textContent ?? '').trim() === label,
  ) as HTMLButtonElement | undefined;
export const goButton = () => box()?.querySelector('.ou-local-pr-go') as HTMLButtonElement;
/** Go as the form sends it: the submit its button makes (linkedom does not turn a click into one). */
export const submitGo = () => fire(box()!.querySelector('form')!, 'submit');
/** An answer that waits: `release(then)` lets the call finish with what `then` returns (or throws). */
export function held() {
  let release: (then: () => unknown) => void = () => {};
  const waiting = new Promise<() => unknown>((resolve) => (release = resolve));
  return {
    answer: () => waiting.then((then) => then()),
    release: (then: () => unknown) => release(then),
  };
}
export const isOn = (one: HTMLButtonElement) => !one.hasAttribute('disabled');

/** Waits for what the open box does on its own (the load, a click's calls, an effect that runs after the next frame): a loaded machine delays them. */
export const settle = async () => {
  for (let round = 0; round < 8; round++) {
    await tick();
  }
};

export const commit = (sha: string, subject: string) => ({ sha: sha.padEnd(40, '0'), subject });

/** A local story as the page holds it. */
export function story(overrides: Record<string, unknown> = {}) {
  return {
    id: 'story-1',
    title: 'A story',
    version: 'v1',
    read_only: false,
    local: {
      repo: 'acme/widgets',
      base: 'main',
      head: 'work',
      base_oid: 'a'.repeat(40),
      branch: 'work',
      ship: 'pr',
      head_oid: 'b'.repeat(40),
      approved: null,
      storyless: false,
      moved: null,
      commits: [],
      hide_whitespace: false,
      diff_view: 'unified',
      notes: [],
      files: [],
      ...overrides,
    },
    chapters: [],
  } as never;
}

/** A file of the story's diff: one hunk of `lines` (each with its ' ', '-' or '+'), the old side starting at line 1 and the new at line 1. */
export function file(rel: string, lines: string[], over: Record<string, unknown> = {}) {
  const old = lines.filter((line) => line[0] !== '+').length;
  const added = lines.filter((line) => line[0] !== '-').length;
  return {
    rel,
    sha: `sha-${rel.replace(/\W/g, '-')}`,
    kind: 'modified',
    stats: {
      added: lines.filter((line) => line[0] === '+').length,
      removed: lines.filter((line) => line[0] === '-').length,
    },
    hunks: [{ oldStart: 1, oldLines: old, newStart: 1, newLines: added, header: '', lines }],
    renamed_from: null,
    binary: false,
    hash: `hash-${rel}`,
    whitespace_only: false,
    viewed: false,
    viewed_changed: false,
    ...over,
  };
}

/** The page drawn whole from the store into a div on the body (the test's own boxes are not drawn then). Returns what a test needs to take it down. */
export async function mountApp(
  over: Record<string, unknown> = {},
  state: Record<string, unknown> = {},
) {
  const { drawInto } = await import('../public/local/app.ts');
  const host = document.createElement('div');
  document.body.appendChild(host);
  store.set({ story: story(over), ...state } as never);
  drawInto(host);
  return {
    host,
    unmount() {
      render(null, host);
      store.attach(() => {}); // nothing draws into the host that is gone when the state changes again
      host.remove();
    },
  };
}
