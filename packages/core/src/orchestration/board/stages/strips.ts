/** The strips around the columns: the pinned voice session above them, and the Blank sessions strip in the Idle lane. */
import { voiceStatus } from '../voice.ts';
import type { readVoice } from '../../../adapters/larmor.ts';
import type { LedgerAgent } from '../../../records/agents/ledger.ts';
import type { BoardData, BoardSession, BoardVoice } from '@once-upon-a-diff/contracts/types';
import { forgotten } from './agents.ts';
import type { PinnedVoice } from './types.ts';

/** The pinned strip's data, or null when voice is off or its session isn't running. */
export function voiceOf(
  pinned: PinnedVoice | null,
  files: ReturnType<typeof readVoice>,
  agents: LedgerAgent[],
  nowMs: number,
  lines: BoardVoice['lines'],
): BoardVoice | null {
  if (!pinned || !files) {
    return null;
  }
  const mine = agents.filter((agent) => pinned.view.id.startsWith(agent.sid));
  return {
    name: files.name || pinned.view.title,
    title: pinned.view.title,
    repo: pinned.repo,
    lane: pinned.lane,
    branch: pinned.view.branch,
    status: voiceStatus(files, pinned.busy, nowMs),
    since: pinned.view.since,
    agents: {
      running: mine.filter((agent) => agent.state === 'running').length,
      waiting: mine.filter(
        (agent) => agent.state === 'waiting' && !agent.review && !forgotten(agent, nowMs),
      ).length,
      review: mine.filter((agent) => agent.review && !forgotten(agent, nowMs)).length,
    },
    session: pinned.view.id,
    can_focus: pinned.view.focus,
    context: pinned.view.context ?? null,
    lines,
  };
}

/** The blank sessions grouped by lane (a repo's owner/name, else the folder's), the lanes by label and a lane's sessions by title. */
export function blankStrip(
  views: { lane: string; view: BoardSession }[],
  labels: Map<string, string>,
): BoardData['blank'] {
  const groups = new Map<string, BoardData['blank'][number]>();
  for (const { lane, view } of views) {
    const group = groups.get(lane.toLowerCase()) || {
      key: lane,
      name: labels.get(lane) ?? lane,
      sessions: [],
    };
    group.sessions.push({
      id: view.id,
      title: view.title,
      can_focus: view.focus,
      since: view.since,
    });
    groups.set(lane.toLowerCase(), group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      sessions: group.sessions.sort((first, second) => first.title.localeCompare(second.title)),
    }))
    .sort((first, second) => first.name.localeCompare(second.name));
}
