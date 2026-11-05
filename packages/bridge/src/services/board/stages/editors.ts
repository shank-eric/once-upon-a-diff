/**
 * Editors: the sessions running a repo's build queue (`/once-upon-editor`), and the authors each controls. An
 * editor registers itself (`once-upon agent start NAME --kind editor --slots N`), so the board knows it and its slots
 * from fields. An author is linked to its editor by the session it was launched from (its registered sid), never by
 * its name or its task: an author, registered as one or holding a backlog claim, launched under an editor's session is
 * that editor's author. Critics, storytellers and helpers are not authors.
 */
import { agentKey } from '../../backlog/claims.ts';
import { lastActivity, type LedgerAgent } from '../../ledger/ledger.ts';
import { STALE_MS, beatOf } from '../../ledger/events.ts';
import type { LiveSession } from '../../../adapters/claude-sessions/live-sessions.ts';
import type { BoardAgentEditor, BoardBeat, BoardEditor } from '@once-upon-a-diff/protocol/types';
import { laneOf } from './lanes.ts';
import { sameLaneKey, shortLane } from '@once-upon-a-diff/domain/lane-key';

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

/** Whether an agent is an author: registered as one, or (a ledger agent, which has no kind) it holds a claim on a card. */
const isAuthor = (agent: LedgerAgent, claimers: Set<string>): boolean =>
  agent.source === 'events' ? agent.kind === 'author' : claimers.has(agentKey(agent));

export interface EditorFacts {
  /** the registered editors (`kind: 'editor'`), read apart from the agents */
  editors: LedgerAgent[];
  agents: LedgerAgent[];
  beats: Map<string, BoardBeat>;
  live: LiveSession[];
  /** whether a session's tab can be brought forward (the status source knows it, as a session card's focus) */
  canFocus: (session: string) => boolean;
  /** the keys of the agents whose current run holds a claim (claims.ts claimerKeys) */
  claimers: Set<string>;
  nowMs: number;
}

/**
 * The editors to show, and the link from an agent to its editor. An editor's authors are its open authors (not stale:
 * an agent silent past the stale mark is likely dead). Its `in_use` count is the slots in use: only an author that is
 * working (running, or fixing findings) holds one, so one at a plan, a question or a story review does not. `label` starts as the lane's short name and the
 * board sets it to the lane label once all the lanes are known (index.ts).
 */
export function editorsOf(facts: EditorFacts): {
  editors: BoardEditor[];
  editorOf: (agent: LedgerAgent) => BoardAgentEditor | null;
  /** sets every label (the editors', and those on their authors) to the lane's label */
  relabel: (labels: Map<string, string>) => void;
} {
  const { agents, beats, claimers, nowMs } = facts;
  const links = new Map<string, BoardAgentEditor>();
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
    const authors = agents
      .filter(
        (agent) =>
          agent.sid === editor.sid &&
          isAuthor(agent, claimers) &&
          OPEN.includes(agent.state) &&
          nowMs - (lastActivity(agent) ?? agent.started ?? new Date(nowMs)).getTime() <= STALE_MS,
      )
      .sort((first, second) => (first.started?.getTime() ?? 0) - (second.started?.getTime() ?? 0));
    shown.push({
      ...link,
      name: editor.name,
      slots: editor.slots ?? 3,
      in_use: authors.filter((agent) => agent.state === 'running' || agent.state === 'fixing')
        .length,
      since: editor.started?.toISOString() ?? null,
      authors: authors.map((agent) => ({
        key: agentKey(agent),
        name: agent.name,
        state: agent.state,
        review: !!agent.review,
        task: agent.task,
        beat: beatOf(agent, beats) ?? null,
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
    // an author of any state (a finished one keeps its editor on its card); a ledger agent is one only by its claim
    editorOf: (agent) =>
      agent.kind !== 'editor' && isAuthor(agent, claimers) ? (links.get(agent.sid) ?? null) : null,
  };
}
