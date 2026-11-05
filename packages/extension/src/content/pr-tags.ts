/*
 * The story tags on every page that shows them: PR lists, a PR's
 * Conversation tab and its Files changed page. It looks PRs up with one
 * batched POST /api/stories/status-many, keeps the answers by PR, handles
 * the tags' clicks (Build story, Update, Re-tell, and on Files changed the
 * Story link, which opens the panel) and keeps the page's "No session
 * listening" notice (components/listen-notice.ts). Each page says where its tags go and
 * when to look. It also owns the tags' poll (a createPoll): while a story is queued, building or updating it asks the page
 * to look again every 10 s, and every 30 s while the bridge doesn't answer, while the tab shows and when it gets focus.
 */
import { prKey } from '@once-upon-a-diff/domain/pr-key';
import { ROUTES } from '@once-upon-a-diff/contracts/routes';
import { bridge, extensionAlive, usage, type BridgeAnswer } from './bridge.ts';
import type { Listening, StatusMany } from '@once-upon-a-diff/contracts/types';
import type { PrRef, StoryStatus } from './tag-model.ts';
import { listenNotice } from './components/listen-notice.ts';
import { answersBadge, tagFor, requestFor, missingListeners } from './tag-model.ts';
import { createTagHost, showTag, clickedTagButton } from './components/tag-host.ts';
import { createTagPoll, pollTargets } from './tag-poll.ts';

const MAX_PER_CALL = 200;
const LISTENER_LOOKS_MS = [5000, 10000, 15000]; // after Start listening typed its line: asks who listens at about 5, 15 and 30 s

/** The PR title on the classic and the React PR pages (Conversation and Files changed). */
export function titleElement(): Element | null {
  return document.querySelector(
    '.gh-header-title .js-issue-title, h1.gh-header-title, [data-component="PH_Title"] h1, [data-testid="issue-title"], main h1 bdi, main h1',
  );
}

/**
 * attr marks the tag hosts on the page; onStory, when given, is what clicking a Story link does instead of
 * following it. onDue is what the page does when the poll says some PRs are due a new look: the ones in flight, or all
 * the ones it has an answer for while the bridge is down. scope, for a page that shows one PR, says which PRs the poll
 * watches: the one on screen, so a PR the page has navigated away from is never looked at again.
 */
export function createPrTags({
  attr,
  onStory,
  onDue,
  scope,
}: {
  attr: string;
  onStory?: (pr: PrRef) => void;
  onDue?: (prs: PrRef[]) => void | Promise<void>;
  scope?: () => PrRef[];
}) {
  const results = new Map<string, StoryStatus>(); // "owner/repo#n" -> a status-many result
  let listening: Record<string, Listening> = {}; // repo -> {ok, prompt, details, checkout}
  let failed = false;
  let noticeRepos: string[] = [];
  let relook: ReturnType<typeof setTimeout> | undefined;
  // Start listening typed a line: the listener needs a few seconds to load the skill and start its wait, so the page asks who
  // listens at about 5, 15 and 30 s, and stops once the repos no longer show as missing
  const notice = listenNotice({
    onStarted: () => {
      clearTimeout(relook);
      const again = (step: number) => {
        relook = setTimeout(async () => {
          const known = [...results.values()].filter(
            (result): result is StoryStatus & PrRef => !!result.repo && !!result.number,
          );
          if ((await look(known, { force: true })).ok) {
            showNotice(noticeRepos);
          }
          if (step + 1 < LISTENER_LOOKS_MS.length && stillMissing()) {
            again(step + 1);
          }
        }, LISTENER_LOOKS_MS[step]);
      };
      again(0);
    },
  });
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
    const answer = await bridge.call(ROUTES.statusMany, {
      body: { prs: need.map(({ repo, number }) => ({ repo, number })) },
    });
    failed = !answer.ok;
    if (answer.ok) {
      for (const result of answer.body.results) {
        results.set(prKey(result.repo as string, result.number as number), result);
      }
      listening = { ...listening, ...(answer.body.listening || {}) };
    }
    poll.reschedule(); // the wait starts from this look
    return answer;
  }

  /** The PRs the poll looks up again (see pollTargets): the page's own PR when it says which. */
  const waiting = () => pollTargets(results, failed, scope ? scope() : null);

  // the tags' poll: look() and a click start its wait again, so it is 10 s from the last look
  const poll = createTagPoll({
    failed: () => failed,
    waiting,
    alive: extensionAlive,
    onDue: (prs) => onDue?.(prs),
  });
  poll.start();

  async function onClick(event: Event, pr: PrRef, host: Element) {
    usage.count('ext.prTag.click');
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
    const answer = await bridge.call(ROUTES.buildRequest, {
      body: requestFor(tag, pr, { retell }),
    });
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
      poll.reschedule();
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
      showTag(host, tagFor(result, pr), answersBadge(result, pr));
    }
  }

  /** Whether a repo on the page still has no listener. */
  function stillMissing() {
    const onPage = new Set(noticeRepos.map((repo) => repo.toLowerCase()));
    return (
      missingListeners(
        Object.fromEntries(
          Object.entries(listening).filter(([repo]) => onPage.has(repo.toLowerCase())),
        ),
      ).length > 0
    );
  }

  /** The notice for the repos on the page that no session is listening for. */
  function showNotice(repos: string[]) {
    noticeRepos = repos;
    const onPage = new Set(repos.map((repo) => repo.toLowerCase()));
    const here = Object.entries(listening).filter(([repo]) => onPage.has(repo.toLowerCase()));
    notice.set(missingListeners(Object.fromEntries(here)));
  }

  function clear() {
    clearTimeout(relook);
    results.clear();
    failed = false;
    listening = {};
    poll.reschedule();
    notice.remove();
  }

  return {
    look,
    resultOf,
    hostFor,
    show,
    showNotice,
    hideNotice: notice.remove,
    forget: (pr: PrRef) => results.delete(keyOf(pr)),
    clear,
  };
}
