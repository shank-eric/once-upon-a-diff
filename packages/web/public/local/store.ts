/*
 * The local page's state, in one store. The page is one Preact tree drawn from it (app.ts): every change `set`s a patch, and
 * the page is drawn again from the new state in the same microtask (`flush()` draws it now, which the panel's callbacks use:
 * the panel jumps to a line right after it asks the page to unfold it, and reads the DOM in the same tick). There are no
 * per-component subscriptions, so no hook state a synchronous draw could miss: the root is drawn from `get()` and passes
 * slices down as props. A `set` made while a draw is running (an effect that mounts the panel, whose first filter pass narrows
 * the diff) is drawn in the next microtask.
 */
import type { LocalStoryData } from '/assets/local/page.ts';
import type { PrView } from '/assets/types.ts';
import type { Side } from '/assets/domain/line-refs.ts';

/** An open note form: one a row (`row` is the row's key in diff/rows.ts), `key` being the file and the row. `focus` goes up when its row's number is clicked again. */
export interface EditorState {
  key: string;
  rel: string;
  row: string;
  side: Side;
  line: number;
  focus: number;
}

export type DialogName = 'push' | 'push-ahead' | 'pr';

/** What Approve, Push and Create pull request know across reloads of the story. */
export interface ShipState {
  dialog: DialogName | null;
  /** why the last Approve failed, shown beside the button */
  approveFailure: string;
  /** the commit is on GitHub or the branch has a PR: nothing left to approve (sticky until the page is reloaded) */
  hasPull: boolean;
  /** set once a push to the default branch has gone through, so the header says so */
  pushedAt: string | null;
  /** where the branch last stood on GitHub (the header's PR buttons) */
  prView: PrView | null;
}

export interface LocalState {
  /** null until the first load */
  story: LocalStoryData | null;
  loadError: string | null;
  /** goes up each time the whole story is read again (a new version, a changed preference): the panel is mounted again on the new DOM */
  generation: number;
  /** the scroll position to come back to once the story was drawn again */
  scrollKeep: number | null;
  /** the panel is open */
  panelOpen: boolean;
  /** the reviewer closed the panel: the page offers Show story, and its poll looks for new versions itself */
  hidden: boolean;
  /** a file's fold, when the reviewer set one; else a viewed file is folded */
  folds: Record<string, boolean>;
  /** the panel's step and whether it shows all files; null for the whole diff */
  step: { n: number; all: boolean } | null;
  /** per file, the keys of the rows of the narrowing folds the reviewer opened (a fold a note splits stays open on both sides) */
  opened: Record<string, Record<string, true>>;
  editors: EditorState[];
  ship: ShipState;
  /** a note the page should scroll to once its file is unfolded and drawn */
  pendingScroll: { note: string } | null;
}

export const initialState = (): LocalState => ({
  story: null,
  loadError: null,
  generation: 0,
  scrollKeep: null,
  panelOpen: false,
  hidden: false,
  folds: {},
  step: null,
  opened: {},
  editors: [],
  ship: { dialog: null, approveFailure: '', hasPull: false, pushedAt: null, prView: null },
  pendingScroll: null,
});

/** A store drawn by `draw`, which `attach` gives it. */
export function createStore<S extends object>(initial: S) {
  let state = initial;
  let draw: ((state: S) => void) | null = null;
  let dirty = false;
  let scheduled = false;
  let drawing = false;
  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        flush();
      });
    }
  };
  /** Draws now when something changed since the last draw. A call from inside a draw is drawn in the next microtask. */
  function flush() {
    if (!draw || !dirty) {
      return;
    }
    if (drawing) {
      schedule();
      return;
    }
    dirty = false;
    drawing = true;
    try {
      draw(state);
    } finally {
      drawing = false;
    }
    if (dirty) {
      schedule();
    }
  }
  return {
    get: () => state,
    /** Changes the state (a patch, or a function of the state that answers one) and draws it in the same microtask. */
    set(patch: Partial<S> | ((state: S) => Partial<S>)) {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      dirty = true;
      schedule();
    },
    flush,
    /** Starts drawing with `draw`, and draws once. */
    attach(next: (state: S) => void) {
      draw = next;
      dirty = true;
      flush();
    },
  };
}

export const store = createStore<LocalState>(initialState());

/** The story, for code that runs once it has loaded. */
export const storyOf = (state: LocalState = store.get()) => state.story as LocalStoryData;
