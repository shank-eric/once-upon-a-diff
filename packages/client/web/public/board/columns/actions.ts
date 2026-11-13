/** The bridge calls behind a card's or a row's buttons. */
import { ROUTES } from '/assets/contracts/routes.ts';
import { titleOf, type Api } from '/assets/board/shared.ts';

/** Asks first, then has the bridge type the line into the session's tab (it refuses a session that is busy). Build story names its card. */
export async function typeInto(
  api: Api,
  kind: 'build' | 'listen',
  session: string,
  line: string,
  repo: string | null,
  card: string | null = null,
) {
  if (
    !window.confirm(`Type this into "${titleOf(api.board, session)}" and press Enter?\n\n${line}`)
  ) {
    return;
  }
  try {
    await api.bridge.ask(ROUTES.boardType, {
      body: { kind, session, ...(repo ? { repo } : {}), ...(card ? { card } : {}) },
    });
  } catch (err) {
    alert(`Couldn't type into the session: ${(err as Error).message}`);
  }
  await api.refresh();
}

/**
 * Runs a bridge call for a card's button, says why when it fails, and polls again whether it worked or not (a refused write
 * often means the board was stale; none when no `api` is given, for a call that changes nothing on the board). The button
 * it sits on is an ActionButton, busy until this has settled.
 */
export async function act(what: string, call: () => Promise<unknown>, api?: Api) {
  try {
    await call();
  } catch (err) {
    alert(`Couldn't ${what}: ${(err as Error).message}`);
  }
  await api?.refresh();
}

/** Opens a local story's page in a tab (the bridge makes the link). */
export const openStory = (api: Api, story: string) =>
  act('open the story', async () => {
    const { url } = await api.bridge.ask(ROUTES.boardOpenStory, { body: { story } });
    window.open(url, '_blank', 'noopener');
  });

/** Review: the bridge makes a storyless review of the card's branch (the diff and Create pull request), and its page opens. */
export const reviewCard = (api: Api, card: string) =>
  act('open the review', async () => {
    const { url } = await api.bridge.ask(ROUTES.boardReview, { body: { card } });
    window.open(url, '_blank', 'noopener');
  });
