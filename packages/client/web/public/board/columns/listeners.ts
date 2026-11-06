/** The Listeners lane: a row per repo, who listens (with Stop) or when it last did (with Start). */
import { html } from '/assets/preact.mjs';
import { ROUTES } from '/assets/contracts/routes.ts';
import { MenuButton } from '/assets/ui-kit/components/menu.ts';
import { ActionButton } from '/assets/ui-kit/components/action-button.ts';
import type { BoardListenerRepo } from '/assets/types.ts';
import { compactAge, since } from '/assets/terms/time.ts';
import { SessionLink, type Api } from '/assets/board/shared.ts';
import { act, typeInto } from '/assets/board/columns/actions.ts';
import { listenPlan } from '/assets/ui-kit/listen.ts';

/** One listener row: who listens (with Stop), or when it last did (with Start). */
function Listener(props: { entry: BoardListenerRepo; now: number; api: Api }) {
  const { entry, now, api } = props;
  const active = entry.active;
  if (active) {
    const parts = [
      active.since && `for ${since(active.since, now)}`,
      active.last_handled_at
        ? `last request ${since(active.last_handled_at, now)} ago`
        : 'no request yet',
      active.state === 'handling' ? 'handling one now' : active.busy && 'busy now',
    ].filter(Boolean);
    const stop = () =>
      window.confirm(
        `Stop listening for ${entry.repo}? Its session's wait ends within a couple of seconds.`,
      )
        ? act(
            'stop it',
            () => api.bridge.ask(ROUTES.boardStopListening, { body: { repo: entry.repo } }),
            api,
          )
        : undefined;
    return html`<li class="ou-board-listener"><strong>${entry.repo}</strong> <span class="ou-board-voice-status">Listening</span> <span class="ou-local-muted"><${SessionLink} bridge=${api.bridge} session=${active.session} canFocus=${active.can_focus} name=${active.title || active.consumer} title="Bring the listening session to the front" /> · ${parts.join(' · ')}</span>${' '}
      <${ActionButton} attrs=${{ 'data-stop-listening': entry.repo }} onClick=${stop}>Stop listening</${ActionButton}></li>`;
  }
  const seen = entry.last_seen ? ` · last listened ${since(entry.last_seen, now)} ago` : '';
  // one obvious session (the only one, or clearly the freshest): the button uses it; else it opens a menu of them, freshest first
  const plan = listenPlan(entry.candidates);
  const choosing = plan.kind === 'choose';
  const line = `/once-upon-listen ${entry.repo}`;
  let title = 'No idle session in this repo has an iTerm tab';
  if (entry.candidates.length) {
    title = choosing
      ? 'Choose an idle session in the repo to type /once-upon-listen into'
      : `Types /once-upon-listen ${entry.repo} into an idle session in the repo`;
  }
  const start = () => {
    if (plan.kind === 'one') {
      void typeInto(api, 'listen', plan.session.id, line, entry.repo);
    }
  };
  const sessions = () =>
    (plan.kind === 'choose' ? plan.sessions : []).map((one) => ({
      value: one.id,
      label: one.title,
      detail: `${one.status}${one.since ? ` ${compactAge(one.since, Date.now())}` : ''} · ${entry.repo}`,
    }));
  const button = choosing
    ? html`<${MenuButton} data-start-listening=${entry.repo} items=${sessions} onPick=${(id: string) => void typeInto(api, 'listen', id, line, entry.repo)} label=${`Sessions in ${entry.repo}`} title=${title}>Start listening ▾</${MenuButton}>`
    : html`<button type="button" data-start-listening=${entry.repo} disabled=${!entry.candidates.length} onClick=${start} title=${title}>Start listening</button>`;
  return html`<li class="ou-board-listener"><strong>${entry.repo}</strong> <span class="ou-local-muted">not listening${seen}</span>${' '}
    ${button}</li>`;
}

/** The Listeners lane: a row per repo, who listens (with Stop) or when it last did (with Start). */
export function Listeners(props: { repos: BoardListenerRepo[]; now: number; api: Api }) {
  const { repos, now, api } = props;
  if (!repos.length) {
    return null;
  }
  return html`<section class="ou-board-listeners" aria-label="Listeners"><h2 class="ou-board-head">Listeners <span class="ou-local-muted">${repos.filter((entry) => entry.active).length}</span></h2><ul>${repos.map((entry) => html`<${Listener} key=${entry.repo} entry=${entry} now=${now} api=${api} />`)}</ul></section>`;
}
