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
    await api.refresh();
  } catch (err) {
    alert(`Couldn't type into the session: ${(err as Error).message}`);
  }
}

/** Runs a bridge call for a card's button, says why when it fails, and polls again when it worked. */
export async function act(what: string, call: () => Promise<unknown>, api?: Api) {
  try {
    await call();
    await api?.refresh();
  } catch (err) {
    alert(`Couldn't ${what}: ${(err as Error).message}`);
  }
}

/** Opens a local story's page in a tab (the bridge makes the link), with the Push box open when `push`. */
export const openStory = (api: Api, story: string, push: boolean) =>
  act('open the story', async () => {
    const { url } = await api.bridge.ask(ROUTES.boardOpenStory, { body: { story } });
    window.open(push ? `${url}&push=1` : url, '_blank', 'noopener');
  });

/** Review: the bridge makes a storyless review of the card's branch (the diff, Create pull request and Push), and its page opens. */
export const reviewCard = (api: Api, card: string) =>
  act('open the review', async () => {
    const { url } = await api.bridge.ask(ROUTES.boardReview, { body: { card } });
    window.open(url, '_blank', 'noopener');
  });
