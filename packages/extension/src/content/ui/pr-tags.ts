/*
 * The story tags on every page that shows them: PR lists, a PR's
 * Conversation tab and its Files changed page. It looks PRs up with one
 * batched POST /api/stories/status-many, keeps the answers by PR, handles
 * the tags' clicks (Build story, Update, Re-tell, and on Files changed the
 * Story link, which opens the panel) and keeps the page's "No session
 * listening" notice (listen-notice.js). Each page says where its tags go and
 * when to look.
 */
import { prKey } from '@once-upon-a-diff/shared/util/github-paths';
import { callBridge, type BridgeAnswer } from '../bridge.ts';
import type { Listening } from '@once-upon-a-diff/shared/types';
import type { BuildRequestView, PrRef, StoryStatus } from './story-tag.ts';
import { listenNotice } from './listen-notice.ts';
import { tagFor, tagHtml, requestFor, missingListeners } from './story-tag.ts';
import { createTagHost, showTag, clickedTagButton } from './tag-host.ts';

const MAX_PER_CALL = 200;
const LOOK_AGAIN_MS = 10000; // while a story is queued, building or updating
const OFFLINE_MS = 30000; // while the bridge doesn't answer

/** POST /api/stories/status-many's answer. */
interface StatusMany {
  results: StoryStatus[];
  listening?: Record<string, Listening>;
}

export const inFlight = (result: StoryStatus | null) =>
  !!result && (result.state === 'queued' || result.state === 'building' || !!result.updating);

/** The PR title on the classic and the React PR pages (Conversation and Files changed). */
export function titleElement(): Element | null {
  return document.querySelector(
    '.gh-header-title .js-issue-title, h1.gh-header-title, [data-component="PH_Title"] h1, [data-testid="issue-title"], main h1 bdi, main h1',
  );
}

/**
 * attr marks the tag hosts on the page; onStory, when given, is what clicking a Story link does instead of
 * following it.
 */
export function createPrTags({ attr, onStory }: { attr: string; onStory?: (pr: PrRef) => void }) {
  const results = new Map<string, StoryStatus>(); // "owner/repo#n" -> a status-many result
  let listening: Record<string, Listening> = {}; // repo -> {ok, prompt, details, checkout}
  let lastAsk = 0;
  let failed = false;
  const notice = listenNotice();
  const keyOf = (pr: PrRef) => prKey(pr.repo, pr.number);
  const resultOf = (pr: PrRef): StoryStatus | null => results.get(keyOf(pr)) || null;

  /**
   * Looks up the PRs ({repo, number}) it doesn't know yet, or all of them with force, in one call.
   * Resolves to the bridge's answer ({ok: true} when there was nothing to ask).
   */
  async function look(
    prs: PrRef[],
    { force = false } = {},
  ): Promise<Partial<BridgeAnswer<StatusMany>> & { ok: boolean }> {
    const need = prs.filter((pr) => force || !results.has(keyOf(pr))).slice(0, MAX_PER_CALL);
    if (!need.length) {
      return { ok: true };
    }
    const answer = await callBridge<StatusMany>('POST', '/api/stories/status-many', {
      prs: need.map(({ repo, number }) => ({ repo, number })),
    });
    lastAsk = Date.now();
    failed = !answer.ok;
    if (answer.ok) {
      for (const result of answer.body.results) {
        results.set(prKey(result.repo as string, result.number as number), result);
      }
      listening = { ...listening, ...(answer.body.listening || {}) };
    }
    return answer;
  }

  /**
   * The PRs to look up again now: the ones in flight every 10s, or all of them every 30s while the bridge is down.
   * prs: the page's PRs, or by default every PR it has an answer for.
   */
  // (status-many's lines carry repo and number; a line a click set does not, and keys as undefined#undefined)
  function due(prs: PrRef[] = [...results.values()] as PrRef[]): PrRef[] {
    if (failed) {
      return Date.now() - lastAsk > OFFLINE_MS ? prs : [];
    }
    const waiting = prs.filter((pr) => inFlight(resultOf(pr)));
    return waiting.length && Date.now() - lastAsk > LOOK_AGAIN_MS ? waiting : [];
  }

  async function onClick(event: Event, pr: PrRef, host: Element) {
    const button = clickedTagButton(event);
    if (!button) {
      const link =
        (event.composedPath()[0] as Element).closest &&
        (event.composedPath()[0] as Element).closest('a');
      if (link && onStory) {
        event.preventDefault();
        onStory(pr);
      }
      return; // otherwise the Story link is a plain link
    }
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    const tag = tagFor(resultOf(pr), pr);
    const retell = button.getAttribute('data-act') === 'retell';
    const answer = await callBridge<{ state: string; request: BuildRequestView }>(
      'POST',
      '/api/builds',
      requestFor(tag, pr, { retell }),
    );
    if (answer.ok) {
      const previous = resultOf(pr) || {};
      results.set(
        keyOf(pr),
        tag.act === 'update'
          ? {
              ...previous,
              updating: true,
              update_state: answer.body.state,
              request: answer.body.request,
            }
          : { state: answer.body.state, request: answer.body.request },
      );
    } else {
      button.disabled = false;
    }
    show(host, pr);
  }

  /** A new tag host for this PR, for the page to put where its tag goes. */
  function hostFor(pr: PrRef) {
    const host: HTMLSpanElement = createTagHost(attr, keyOf(pr), (event) =>
      onClick(event, pr, host),
    );
    return host;
  }

  /** Draws this PR's tag in its host, once there's an answer for it. */
  function show(host: Element, pr: PrRef) {
    const result = resultOf(pr);
    if (result) {
      showTag(host, tagHtml(tagFor(result, pr)));
    }
  }

  /** The notice for the repos on the page that no session is listening for. */
  function showNotice(repos: string[]) {
    const onPage = new Set(repos.map((repo) => repo.toLowerCase()));
    const here = Object.entries(listening).filter(([repo]) => onPage.has(repo.toLowerCase()));
    notice.set(missingListeners(Object.fromEntries(here)));
  }

  function clear() {
    results.clear();
    listening = {};
    notice.remove();
  }

  return {
    look,
    due,
    resultOf,
    hostFor,
    show,
    showNotice,
    hideNotice: notice.remove,
    forget: (pr: PrRef) => results.delete(keyOf(pr)),
    clear,
  };
}
