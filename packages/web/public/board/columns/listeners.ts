/** The Listeners lane: a row per repo, who listens (with Stop) or when it last did (with Start). */
import { html } from '/assets/preact.mjs';
import { ROUTES } from '/assets/contracts/routes.ts';
import { openMenu } from '/assets/ui-kit/menu.ts';
import type { BoardListenerRepo } from '/assets/types.ts';
import { compactAge, since } from '/assets/domain/time.ts';
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
    const stop = async () => {
      if (
        window.confirm(
          `Stop listening for ${entry.repo}? Its session's wait ends within a couple of seconds.`,
        )
      ) {
        await act(
          'stop it',
          () => api.bridge.ask(ROUTES.boardStopListening, { body: { repo: entry.repo } }),
          api,
        );
      }
    };
    return html`<li class="ou-board-listener"><strong>${entry.repo}</strong> <span class="ou-board-voice-status">Listening</span> <span class="ou-local-muted"><${SessionLink} bridge=${api.bridge} session=${active.session} canFocus=${active.can_focus} name=${active.title || active.consumer} title="Bring the listening session to the front" /> · ${parts.join(' · ')}</span>${' '}
      <button type="button" data-stop-listening=${entry.repo} onClick=${stop}>Stop listening</button></li>`;
  }
  const seen = entry.last_seen ? ` · last listened ${since(entry.last_seen, now)} ago` : '';
  // several idle sessions and no obvious one: the button opens a menu to pick from
  const choosing = listenPlan(entry.candidates).kind === 'choose';
  let title = 'No idle session in this repo has an iTerm tab';
  if (entry.candidates.length) {
    title = choosing
      ? 'Choose an idle session in the repo to type /once-upon-listen into'
      : `Types /once-upon-listen ${entry.repo} into an idle session in the repo`;
  }
  const start = (event: MouseEvent) => {
    // one obvious session (the only one, or clearly the freshest): use it; else a menu of them, freshest first
    const plan = listenPlan(entry.candidates);
    const line = `/once-upon-listen ${entry.repo}`;
    if (plan.kind === 'one') {
      void typeInto(api, 'listen', plan.session.id, line, entry.repo);
    } else if (plan.kind === 'choose') {
      openMenu(
        event.currentTarget as HTMLElement,
        plan.sessions.map((one) => ({
          value: one.id,
          label: one.title,
          detail: `${one.status}${one.since ? ` ${compactAge(one.since, Date.now())}` : ''} · ${entry.repo}`,
        })),
        (id) => void typeInto(api, 'listen', id, line, entry.repo),
        { label: `Sessions in ${entry.repo}` },
      );
    }
  };
  return html`<li class="ou-board-listener"><strong>${entry.repo}</strong> <span class="ou-local-muted">not listening${seen}</span>${' '}
    <button type="button" data-start-listening=${entry.repo} disabled=${!entry.candidates.length} ...${choosing ? { 'aria-haspopup': 'menu', 'aria-expanded': 'false' } : {}} onClick=${start} title=${title}>Start listening${choosing && ' ▾'}</button></li>`;
}

/** The Listeners lane: a row per repo, who listens (with Stop) or when it last did (with Start). */
export function Listeners(props: { repos: BoardListenerRepo[]; now: number; api: Api }) {
  const { repos, now, api } = props;
  if (!repos.length) {
    return null;
  }
  return html`<section class="ou-board-listeners" aria-label="Listeners"><h2 class="ou-board-head">Listeners <span class="ou-local-muted">${repos.filter((entry) => entry.active).length}</span></h2><ul>${repos.map((entry) => html`<${Listener} key=${entry.repo} entry=${entry} now=${now} api=${api} />`)}</ul></section>`;
}
