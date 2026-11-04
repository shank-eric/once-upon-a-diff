/*
 * Tells the bridge when you act on GitHub (submit a review, open a PR, merge, mark ready, close), so the board's card
 * moves in seconds and not at the bridge's next poll of GitHub. What counts as such an action is host-github/src/actions.ts.
 * The bridge asks GitHub again for that branch's PR (POST /api/github/refresh). A page-shaped module of the router
 * (index.ts) that also runs its own timer while an intent is waiting: acting on GitHub and switching to the board at once is
 * the usual flow, and the router's tick skips a hidden tab.
 *
 * An intent is pinged twice: 1.5 s after (GitHub has the change by then), and 8 s after (GitHub's search, behind the list of
 * your open PRs, lags a few seconds). It is kept in the extension's own chrome.storage.local (never the page's storage, which
 * page scripts can write) because Create pull request and Merge can reload the page, which would end a timer. A ping that
 * doesn't get through is not retried: the poll covers it. Only a click or submit the person made counts (`isTrusted`), so a
 * script on the page can't make the extension call the bridge.
 */
import { ROUTES } from '@once-upon-a-diff/protocol/routes';
import { conversationPr } from '@once-upon-a-diff/host-github/pages';
import {
  intentOfClick,
  intentOfSubmit,
  type El,
  type Intent,
} from '@once-upon-a-diff/host-github/actions';
import { bridge, extensionAlive, type Bridge } from './bridge.ts';

export const FIRST_PING_MS = 1500;
export const SECOND_PING_MS = 8000;
export const DROP_MS = 60_000;
const MAX_PENDING = 5;
const STORE_KEY = 'ou-refresh-pending';

/** An intent waiting for its pings: `pings` is how many were sent. */
export interface Pending extends Intent {
  at: number;
  pings: number;
}

/** Where intents are kept between page loads: the extension's own storage, or nothing. */
export interface PendingStore {
  read(): Promise<Pending[]>;
  write(list: Pending[]): Promise<void> | void;
}

/** How often a waiting intent is looked at, whether or not the tab shows. */
const TIMER_MS = 500;

const sameIntent = (one: Intent, two: Intent) =>
  one.reason === two.reason &&
  one.repo.toLowerCase() === two.repo.toLowerCase() &&
  one.number === two.number &&
  one.branch === two.branch;

/**
 * The pings. `add` takes an intent, `tick` sends what is due: `pathname` is the page's address now, to fill in the number of
 * a PR just opened (the page lands on /owner/repo/pull/N). While an intent waits, a timer of its own ticks too (`timer`, the
 * page's setInterval by default), so a hidden tab still sends. Never throws.
 */
export function createPings({
  call,
  store,
  timer = {
    start: (run, every) => setInterval(run, every),
    stop: (id) => clearInterval(id as never),
  },
  now = Date.now,
  pathname = () => location.pathname,
}: {
  call: (body: Intent) => Promise<unknown>;
  store: PendingStore;
  timer?: { start(run: () => void, every: number): unknown; stop(id: unknown): void };
  now?: () => number;
  pathname?: () => string;
}) {
  let list: Pending[] = [];
  let running: unknown = null;
  const save = () => {
    try {
      void Promise.resolve(store.write(list)).catch(() => undefined);
    } catch {
      /* no storage: the pings go on from memory this page load */
    }
  };
  const watch = () => {
    if (list.length && running === null) {
      running = timer.start(() => tick(now(), pathname()), TIMER_MS);
    } else if (!list.length && running !== null) {
      timer.stop(running);
      running = null;
    }
  };
  function tick(clock: number, path: string) {
    const landed = conversationPr(path);
    const keep: Pending[] = [];
    for (const one of list) {
      const age = clock - one.at;
      if (age > DROP_MS) {
        continue;
      }
      // a PR just opened lands on its own page: now its number is known
      const number =
        one.number ??
        (one.reason === 'open' && landed && landed.repo.toLowerCase() === one.repo.toLowerCase()
          ? landed.number
          : undefined);
      const next: Pending = { ...one, ...(number ? { number } : {}) };
      const due =
        (next.pings === 0 && age >= FIRST_PING_MS) || (next.pings === 1 && age >= SECOND_PING_MS);
      // a fork's PR has no branch of this repo to name: it waits for its number
      if (due && (next.branch || next.number)) {
        const { at: _at, pings, ...body } = next;
        void call(body).catch(() => undefined);
        next.pings = pings + 1;
      }
      if (next.pings < 2) {
        keep.push(next);
      }
    }
    list = keep;
    save();
    watch();
  }
  // what a page that reloaded (Create pull request, Merge) left: only what is still fresh joins what this page has seen since
  void (async () => {
    try {
      const kept = await store.read();
      const fresh = (Array.isArray(kept) ? kept : []).filter(
        (one) => one && typeof one.at === 'number' && now() - one.at <= DROP_MS,
      );
      list = [...fresh.filter((one) => !list.some((seen) => sameIntent(seen, one))), ...list];
      watch();
    } catch {
      /* nothing kept, or storage gone */
    }
  })();
  return {
    pending: () => list,
    add(intent: Intent, when: number) {
      const rest = list.filter((one) => !sameIntent(one, intent));
      list = [...rest, { ...intent, at: when, pings: 0 }].slice(-MAX_PENDING);
      save();
      watch();
    },
    tick,
  };
}

/** The extension's own storage (a page's script can't reach it), or nothing when it is gone. */
const extensionStore = (): PendingStore => ({
  read: async () =>
    extensionAlive()
      ? (((await chrome.storage.local.get(STORE_KEY))[STORE_KEY] as Pending[] | undefined) ?? [])
      : [],
  write: async (list) => {
    if (extensionAlive()) {
      await chrome.storage.local.set({ [STORE_KEY]: list });
    }
  },
});

/** The router's page for it. */
export function createRefreshPage({ client = bridge }: { client?: Bridge } = {}) {
  const pings = createPings({
    call: (body) => client.call(ROUTES.githubRefresh, { body }),
    store: extensionStore(),
  });

  function seen(intent: Intent | null) {
    if (intent && extensionAlive()) {
      pings.add(intent, Date.now());
    }
  }

  return {
    start() {
      // capture phase: before GitHub's own handlers, and still ours when it stops the event
      document.addEventListener(
        'click',
        (event) => {
          if (event.isTrusted) {
            seen(intentOfClick(event.target as unknown as El | null, location.pathname));
          }
        },
        true,
      );
      document.addEventListener(
        'submit',
        (event) => {
          const form = event.target as HTMLFormElement | null;
          if (event.isTrusted && form?.getAttribute) {
            const action = new URL(form.getAttribute('action') || '', location.href);
            seen(intentOfSubmit(action.pathname, location.pathname));
          }
        },
        true,
      );
    },
    route() {
      pings.tick(Date.now(), location.pathname);
    },
  };
}
