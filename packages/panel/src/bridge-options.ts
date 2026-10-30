/*
 * The panel's calls to the bridge that every host makes the same way, built once from the host's client (host.ts): the
 * extension used to spell these out in content/pages/files-changed.ts and the local page in local/mount.ts. A host
 * spreads this into its PanelOptions and adds what is its own (where the panel's state is saved, what closing it does,
 * the status route, how Start listening reaches the bridge) or overrides one call (the local page's Add to fix before push).
 */
import { ROUTES } from '@once-upon-a-diff/protocol/routes';
import type { PanelHost } from './host.ts';
import type { PanelOptions } from './context.ts';

type Shared = Required<
  Pick<
    PanelOptions,
    | 'onPosition'
    | 'onRead'
    | 'reads'
    | 'ask'
    | 'loadQuestions'
    | 'markQuestions'
    | 'working'
    | 'requestRebuild'
    | 'pulse'
  >
> & {
  drafts: NonNullable<PanelOptions['drafts']>;
  fixes: Omit<NonNullable<PanelOptions['fixes']>, 'onChange'>;
};

/** The calls a story's panel makes on its own routes, through the host's client. */
export function bridgeOptions({ client, storyId, pageUrl }: PanelHost): Shared {
  const params = { id: storyId };
  return {
    // a failed position report is not worth telling the reader about
    onPosition: (position) =>
      client
        .ask(ROUTES.storyPosition, { params, body: { ...position, url: pageUrl() } })
        .catch(() => {}),
    // a chapter they read (stayed on, or ticked every file of): the bridge records the range's head commit with it
    onRead: (read) => client.ask(ROUTES.readNote, { params, body: read }),
    reads: () => client.ask(ROUTES.readRead, { params }),
    ask: (question) =>
      client.ask(ROUTES.questionAsk, { params, body: { ...question, url: pageUrl() } }),
    loadQuestions: () =>
      client.ask(ROUTES.questionsRead, { params }).then((answer) => answer.questions),
    markQuestions: (action, ids, extra) =>
      client.ask(ROUTES.questionMarks, { params, body: { action, ids, ...extra } }),
    drafts: {
      load: () => client.ask(ROUTES.draftsRead, { params }),
      act: (chapter, index, action) =>
        client.ask(ROUTES.draftsAct, { params, body: { chapter, index, action } }),
    },
    // fix before push: notes to send to the session working the branch
    fixes: {
      load: () => client.ask(ROUTES.fixesRead, { params }),
      act: (body) => client.ask(ROUTES.fixesAct, { params, body }),
      // the panel edits only a note it drew, which has an id
      note: (noteId, changes) =>
        client.ask(ROUTES.noteUpdate, {
          params: { ...params, note: noteId as string },
          body: changes,
        }),
    },
    working: () => client.ask(ROUTES.working, { params }),
    // Rebuild story / Rebuild from here: a build request for this story
    requestRebuild: (ask) => client.ask(ROUTES.storyRebuildWrite, { params, body: ask }),
    pulse: () => client.ask(ROUTES.storyPulse, { params }),
  };
}
