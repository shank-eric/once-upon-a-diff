/*
 * What the local page does: the calls to the bridge and the changes they make to the store (store.ts). The components draw from
 * the state and call these; the panel's callbacks (mount.ts) call them too. A change the panel is waiting on (it jumps to a line
 * right after asking the page to unfold it) is drawn before the call returns.
 */
import { ROUTES } from '/assets/contracts/routes.ts';
import { bridge, PARAMS } from '/assets/local/page.ts';
import { store, storyOf, type DialogName, type LocalState } from '/assets/local/store.ts';
import { baseRows, claimsFor, rowKeyFor, rowsFor } from '/assets/local/diff/rows.ts';
import type { LocalStoryData } from '/assets/local/page.ts';
import type { LocalFile, LocalNote, LocalStory, PrView } from '/assets/types.ts';
import type { Side } from '/assets/terms/line-refs.ts';

const patchLocal = (patch: Partial<LocalStory>) =>
  store.set((state) => {
    const story = storyOf(state);
    return { story: { ...story, local: { ...story.local, ...patch } } };
  });

const patchFile = (rel: string, patch: Partial<LocalFile>) =>
  patchLocal({
    files: storyOf().local.files.map((file) => (file.rel === rel ? { ...file, ...patch } : file)),
  });

const fileByRel = (rel: string | null) => storyOf().local.files.find((file) => file.rel === rel);

/** The story was read again (a new version, a changed preference): drawn anew, and the panel mounted again on it. Folds, opened narrowing folds and note forms start over. */
export function loadStory(story: LocalStoryData) {
  store.set((state) => ({
    story,
    loadError: null,
    generation: state.generation + 1,
    scrollKeep: window.scrollY,
    folds: {},
    opened: {},
    editors: [],
  }));
}

/** The page was drawn again from what it has (a call that changed a preference failed): folds, opened narrowing folds and note forms start over. */
const redraw = () => store.set({ folds: {}, opened: {}, editors: [] });

/** Reads the story again when its version moved (the panel's pulse says so, or the poll while the panel is closed), unless a note is being written. */
export async function reloadIfChanged(known?: string, signal?: AbortSignal) {
  try {
    const version =
      known ?? (await bridge.ask(ROUTES.storyVersion, { params: PARAMS }, { signal })).version;
    if (version === storyOf().version) {
      return;
    }
    if (store.get().editors.length) {
      return; // don't redraw under a note being written
    }
    loadStory((await bridge.ask(ROUTES.story, { params: PARAMS }, { signal })) as LocalStoryData);
  } catch {
    /* bridge restarting */
  }
}

/** Hide whitespace and Unified/Split: saved by the bridge for every story, then the diff is redrawn under the panel. */
export async function setPref(
  patch: { diffView?: 'unified' | 'split'; hideWhitespace?: boolean },
  what: string,
) {
  try {
    await bridge.ask(ROUTES.storyPrefsWrite, { params: PARAMS, body: patch });
    loadStory((await bridge.ask(ROUTES.story, { params: PARAMS })) as LocalStoryData);
  } catch (err) {
    alert(`Couldn't change ${what}: ${(err as Error).message}`);
    redraw();
  }
}

// ---------- files: Viewed, folds, the tree
export const isFolded = (state: LocalState, file: LocalFile) =>
  state.folds[file.rel] ?? file.viewed;

export async function toggleViewed(rel: string) {
  const file = fileByRel(rel);
  if (!file) {
    return;
  }
  const nowViewed = !file.viewed;
  // a Viewed file folds, and one that was Viewed and changed since says so no more
  store.set((state) => {
    const folds = { ...state.folds };
    delete folds[rel];
    return { folds };
  });
  patchFile(rel, { viewed: nowViewed, viewed_changed: false });
  store.flush();
  try {
    await bridge.ask(ROUTES.viewed, { params: PARAMS, body: { path: rel, viewed: nowViewed } });
  } catch (err) {
    alert(`Couldn't save: ${(err as Error).message}`);
  }
  const section = document.getElementById(`diff-${file.sha}`);
  if (nowViewed && section && section.getBoundingClientRect().top < 0) {
    section.scrollIntoView();
  }
}

export function toggleFold(rel: string) {
  const file = fileByRel(rel);
  if (file) {
    store.set((state) => ({ folds: { ...state.folds, [rel]: !isFolded(state, file) } }));
  }
}

/** A file in the tree was clicked: scroll to it. */
export function gotoFile(rel: string) {
  const file = fileByRel(rel);
  const el = file && document.getElementById(`diff-${file.sha}`);
  if (el) {
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 60 });
  }
}

// ---------- notes
/** A note was added (or came back from the bridge changed): it joins the diff and the list. */
export function upsertNote(note: LocalNote) {
  patchLocal({
    notes: [...storyOf().local.notes.filter((existing) => existing.id !== note.id), note],
  });
}

/** The panel's notes changed (sent, fixed, edited): the diff and the list show the same. */
export function setNotes(notes: LocalNote[]) {
  patchLocal({ notes });
}

export async function deleteNote(id: string) {
  try {
    await bridge.ask(ROUTES.noteUpdate, {
      params: { ...PARAMS, note: id },
      body: { delete: true },
    });
  } catch (err) {
    alert(`Couldn't delete the note: ${(err as Error).message}`);
    return;
  }
  setNotes(storyOf().local.notes.filter((note) => note.id !== id));
}

export async function setDone(id: string, done: boolean) {
  const updated = (await bridge.ask(ROUTES.noteUpdate, {
    params: { ...PARAMS, note: id },
    body: { done },
  })) as LocalNote;
  setNotes(storyOf().local.notes.map((note) => (note.id === id ? updated : note)));
}

/** A note link was clicked: its file unfolds, and the page scrolls to the note once it is drawn. */
export function gotoNote(id: string) {
  const note = storyOf().local.notes.find((candidate) => candidate.id === id);
  if (!note || !fileByRel(note.path)) {
    return;
  }
  store.set((state) => ({
    folds: { ...state.folds, [note.path]: false },
    pendingScroll: { note: id },
  }));
}

/** The note form under a line: opened from its line number, focused again if it's already open. */
export function openEditor(rel: string, side: Side, line: number) {
  const file = fileByRel(rel);
  if (!file) {
    return;
  }
  const row = rowKeyFor(file, storyOf().local.diff_view === 'split', side, line);
  if (row === null) {
    return;
  }
  const key = `${rel}|${row}`;
  store.set((state) => {
    if (state.editors.some((editor) => editor.key === key)) {
      return {
        editors: state.editors.map((editor) =>
          editor.key === key ? { ...editor, focus: editor.focus + 1 } : editor,
        ),
      };
    }
    return { editors: [...state.editors, { key, rel, row, side, line, focus: 0 }] };
  });
}

export const closeEditor = (key: string) =>
  store.set((state) => ({ editors: state.editors.filter((editor) => editor.key !== key) }));

// ---------- the panel's steps: lines other chapters tell fold away
/** Called by the panel after each filter pass. Only a new step (or a redraw) changes the tables, so the folds the reviewer opens stay open. */
export function narrow({ n, all }: { n: number; all: boolean }) {
  const next = all || !n ? null : { n, all };
  const now = store.get().step;
  if (next === null ? now === null : now !== null && now.n === n && now.all === all) {
    return;
  }
  store.set({ step: next, opened: {} });
  store.flush();
}

/** The panel closed: the tables are whole again. */
export function unnarrow() {
  store.set({ step: null, opened: {} });
  store.flush();
}

/** Show was clicked on a fold: its rows (their keys) are opened. */
export function openRun(rel: string, keys: string[]) {
  store.set((state) => ({
    opened: {
      ...state.opened,
      [rel]: { ...state.opened[rel], ...Object.fromEntries(keys.map((key) => [key, true])) },
    },
  }));
}

/** A jump from the panel to a file or its lines: unfold the file (Viewed files fold) and open the folds that hold the lines. Viewed stays as it is. Nothing is changed (and nothing drawn again) when it is all open already. */
export function reveal(rel: string, side?: Side, start?: number, end?: number) {
  const file = fileByRel(rel);
  if (!file) {
    return;
  }
  const state = store.get();
  const patch: Partial<LocalState> = {};
  if (isFolded(state, file)) {
    patch.folds = { ...state.folds, [rel]: false };
  }
  if (state.step && !state.step.all && side && Number.isFinite(start)) {
    const local = storyOf(state).local;
    const split = local.diff_view === 'split';
    const shown = rowsFor({
      file,
      split,
      notes: local.notes.filter((note) => note.path === rel),
      editors: state.editors.filter((editor) => editor.rel === rel),
      claims: claimsFor(storyOf(state).chapters),
      step: state.step,
      opened: state.opened[rel],
    });
    const { anchors, rows } = baseRows(file, split);
    const byKey = new Map(shown.map((row) => [row.key, row]));
    const open: Record<string, true> = {};
    const seen = new Set<string>();
    // start is a number past the isFinite check
    for (
      let line = start!;
      line <= Math.max(start!, end || start!) && line < start! + 400;
      line++
    ) {
      const pos = anchors.get(`${side}${line}`);
      const row = pos === undefined ? undefined : byKey.get(rows[pos].key);
      if (row && row.hidden && row.run && !seen.has(row.run)) {
        seen.add(row.run);
        for (const other of shown) {
          if (other.run === row.run && other.hidden) {
            open[other.key] = true;
          }
        }
      }
    }
    if (Object.keys(open).length) {
      patch.opened = { ...state.opened, [rel]: { ...state.opened[rel], ...open } };
    }
  }
  if (Object.keys(patch).length) {
    store.set(patch);
    store.flush();
  }
}

// ---------- ship
export const openDialog = (dialog: DialogName) =>
  store.set((state) => ({ ship: { ...state.ship, dialog } }));
export const closeDialog = () => store.set((state) => ({ ship: { ...state.ship, dialog: null } }));

const patchShip = (patch: Partial<LocalState['ship']>) =>
  store.set((state) => ({ ship: { ...state.ship, ...patch } }));

/** Approve (or Unapprove) was clicked. */
export async function toggleApprove(approve: boolean) {
  patchShip({ approveFailure: '' });
  try {
    const answer = await bridge.ask(ROUTES.approve, {
      params: PARAMS,
      body: { approved: approve, head_sha: storyOf().local.head_oid },
    });
    patchLocal({ approved: answer.approved });
  } catch (err) {
    patchShip({ approveFailure: (err as Error).message });
  }
}

/** A push to the default branch went through: the header says so, and the commit is on GitHub, so there is nothing left to approve. */
export function pushed(sha: string) {
  patchLocal({ approved: null });
  patchShip({ pushedAt: sha, hasPull: true });
}

/** Takes a look pos where the branch stands (after a push), for the header's buttons. */
export function takeView(view: PrView) {
  patchShip({ prView: view });
}

/** The branch has an open PR: Approve goes. */
export const foundPull = () => patchShip({ hasPull: true });
