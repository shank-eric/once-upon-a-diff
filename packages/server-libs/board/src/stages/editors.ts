/**
 * Editors: the sessions running a repo's build queue (`/once-upon-editor`), and the authors each controls. An
 * editor registers itself (`once-upon editor start --slots N`), so the board knows it and its slots from fields. An author is
 * linked to its editor by the session that claimed its card (the claim's `session`), else by the session it was launched
 * from (its registered sid): one owner each, never by its name or its task: an author (registered `--kind author`) launched under an
 * editor's session is that editor's author. Critics, storytellers and helpers are not authors. The slots in use are
 * `slotsInUse`'s (state/src/queues/backlog/slots.ts), which `once-upon editor slots` answers with too.
 */
import { agentKey } from '@once-upon-a-diff/state/queues/backlog/claims';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import { claimSessionOf, slotsInUse } from '@once-upon-a-diff/state/queues/backlog/slots';
import type { BacklogItem } from '@once-upon-a-diff/state/queues/backlog/types';
import type { LiveSession } from '@once-upon-a-diff/adapters/claude-sessions/live-sessions';
import type { BoardAgentEditor, BoardEditor } from '@once-upon-a-diff/contracts/types';
import { laneOf } from './lanes.ts';
import { sameLaneKey, shortLane } from '@once-upon-a-diff/terms/lane-key';

const OPEN = ['running', 'waiting', 'plan', 'fixing'];

/** The editors that are shown, newest registration first: an open run whose full session id is a live session. One per session. */
function liveEditors(editors: LedgerAgent[], live: LiveSession[]): LedgerAgent[] {
  const bySession = new Map<string, LedgerAgent>();
  for (const editor of editors) {
    const open = OPEN.includes(editor.state);
    // the session it registered from, in full (the sid8 would match another session's prefix)
    if (!open || !editor.session || !live.some((one) => one.session === editor.session)) {
      continue;
    }
    const held = bySession.get(editor.session);
    if (!held || (editor.started?.getTime() ?? 0) > (held.started?.getTime() ?? 0)) {
      bySession.set(editor.session, editor);
    }
  }
  return [...bySession.values()];
}

export interface EditorFacts {
  /** the registered editors (`kind: 'editor'`), read apart from the agents */
  editors: LedgerAgent[];
  agents: LedgerAgent[];
  /** the backlog's items, whose claims name the session that took each card */
  items?: Pick<BacklogItem, 'id' | 'claim'>[];
  live: LiveSession[];
  /** whether a session's tab can be brought forward (the status source knows it, as a session card's focus) */
  canFocus: (session: string) => boolean;
  nowMs: number;
}

/**
 * The editors to show, and the link from an agent to its editor. An editor's authors are its open authors (not stale:
 * an agent silent past the stale mark is likely dead). Its `in_use` count is `slotsInUse`: only an author that is
 * working (running, at its plan check, or fixing findings) holds one, so one at a question or a story review does not. `label` starts as the lane's short name and the
 * board sets it to the lane label once all the lanes are known (index.ts).
 */
export function editorsOf(facts: EditorFacts): {
  editors: BoardEditor[];
  editorOf: (agent: LedgerAgent) => BoardAgentEditor | null;
  /** sets every label (the editors', and those on their authors) to the lane's label */
  relabel: (labels: Map<string, string>) => void;
} {
  const { agents, nowMs } = facts;
  const items = facts.items ?? [];
  const links = new Map<string, BoardAgentEditor>();
  const bySession = new Map<string, BoardAgentEditor>();
  const shown: BoardEditor[] = [];
  for (const editor of liveEditors(facts.editors, facts.live)) {
    const lane = laneOf(editor.cwd ?? '', editor.repo ?? null);
    const session = editor.session as string;
    const link: BoardAgentEditor = {
      lane,
      label: shortLane(lane),
      title: facts.live.find((one) => one.session === session)?.name || editor.sid,
      session,
      can_focus: facts.canFocus(session),
    };
    links.set(editor.sid, link);
    bySession.set(session, link);
    const { slots, in_use, authors } = slotsInUse(editor, agents, items, nowMs);
    shown.push({
      ...link,
      name: editor.name,
      slots,
      in_use,
      since: editor.started?.toISOString() ?? null,
      authors: authors.map((agent) => ({
        key: agentKey(agent),
        name: agent.name,
        state: agent.state,
        review: !!agent.review,
        task: agent.task,
        beat: agent.beat ?? null,
      })),
    });
  }
  return {
    relabel: (labels) => {
      // two editors on one lane are told apart by their sessions' names
      const sharing = (lane: string) => shown.filter((one) => sameLaneKey(one.lane, lane));
      const labelOf = (one: BoardAgentEditor) => {
        const label = labels.get(one.lane) ?? one.label;
        const group = sharing(one.lane);
        if (group.length < 2) {
          return label;
        }
        // two tabs can have one name: then the first 8 of the session's id tell them apart
        const same = group.filter((other) => other.title === one.title).length > 1;
        return `${label} (${same ? one.session.slice(0, 8) : one.title})`;
      };
      for (const link of links.values()) {
        link.label = labelOf(link);
      }
      for (const editor of shown) {
        editor.label = labelOf(editor);
      }
      // in the order the labels read, so "widgets (alpha)" is above "widgets (beta)"
      shown.sort((first, second) => first.label.localeCompare(second.label));
    },
    editors: shown,
    // an author of any state (a finished one keeps its editor on its card): by the session that claimed its card, else its launching session
    editorOf: (agent) => {
      if (agent.kind !== 'author') {
        return null;
      }
      const claimed = claimSessionOf(agent, items);
      return (claimed ? bySession.get(claimed) : undefined) ?? links.get(agent.sid) ?? null;
    },
  };
}
