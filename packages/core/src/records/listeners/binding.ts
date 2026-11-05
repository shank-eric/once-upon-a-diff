/**
 * A story built by a named subagent is bound to it: the agent has the context, so the story's questions go to it.
 *
 *   <home>/state/<story id>/agent.json   {agent, session, at}
 *
 * `session` is the Claude Code session that owns the agent ($CLAUDE_CODE_SESSION_ID, which a subagent shares with its
 * parent). Only that session can `SendMessage` the agent, so only a `wait --story` run from it relays. A subagent can't
 * wait itself (its background tasks end when it hands back). The relay prints the message to send, and the agent
 * answers with `once-upon answer` (in-process on the inbox file).
 *
 * A binding that can no longer be used is ignored, so it never swallows a question: older than BINDING_FRESH_MS, or its
 * session isn't running any more (Claude Code's session registry has no live process for it). The story's questions then
 * go to the repo's listener as for any story. A session that relays keeps its binding fresh (touchBinding), so a long
 * session's binding doesn't expire under it.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../../adapters/stores/fs/json-file.ts';
import { readSettings, stateFile } from '../../foundation/settings.ts';
import { STORY_ID_RE } from '@once-upon-a-diff/domain/patterns';
import { collapse } from '@once-upon-a-diff/domain/text';
import { startOf, pidAlive } from '../../adapters/os.ts';
import { removeFile } from '../../adapters/stores/fs/files.ts';

export interface Binding {
  agent: string;
  session: string | null;
  at: string;
}

/** A binding older than this is stale: the agent's session has long moved on. */
export const BINDING_FRESH_MS = 24 * 3600 * 1000;

/** An agent name as a brief gives it: short and kebab-case, safe to print into an instruction. */
export const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const fileOf = (home: string, story: string) => stateFile(home, story, 'agent.json');

/** The story's binding as saved, whatever its age, or null. */
export function readBinding(home: string, story: string | null | undefined): Binding | null {
  if (!STORY_ID_RE.test(String(story || ''))) {
    return null;
  }
  const saved = readJson<Partial<Binding> | null>(fileOf(home, story as string), null);
  if (!saved || typeof saved.agent !== 'string' || !AGENT_RE.test(saved.agent)) {
    return null;
  }
  return {
    agent: saved.agent,
    session: typeof saved.session === 'string' && saved.session ? saved.session : null,
    at: typeof saved.at === 'string' ? saved.at : new Date(0).toISOString(),
  };
}

/** Binds the story to the agent, owned by `session` (null when unknown). */
export function writeBinding(
  home: string,
  story: string,
  agent: string,
  session: string | null,
  now = Date.now(),
): Binding {
  if (!STORY_ID_RE.test(String(story || ''))) {
    throw new Error(`not a story id: ${story}`);
  }
  if (!AGENT_RE.test(agent)) {
    throw new Error(`--agent is the agent's name, like ou-fix-thing (letters, digits, . _ -)`);
  }
  const binding = { agent, session, at: new Date(now).toISOString() };
  writeJsonAtomic(fileOf(home, story), binding);
  return binding;
}

/** Removes the story's binding. True when there was one. */
export function clearBinding(home: string, story: string): boolean {
  if (!STORY_ID_RE.test(String(story || ''))) {
    return false;
  }
  const had = !!readBinding(home, story);
  removeFile(fileOf(home, story));
  return had;
}

/** Is the registry file's process the one that wrote it? Its pid is running, and (when ps can say) started when procStart says. */
function sameProcess(pid: number, procStart: unknown): boolean {
  if (!pidAlive(pid)) {
    return false;
  }
  if (typeof procStart !== 'string' || !procStart) {
    return true;
  }
  const start = startOf(pid);
  return !start || start === collapse(procStart); // a reused pid started at another time
}

/** What was last found for a session, kept briefly: a panel pulses every few seconds and each asks. */
const SESSION_CACHE_MS = 2000;
const found = new Map<string, { at: number; live: boolean }>();

/** Forgets what was found about sessions (a session that just started, or a test). */
export const forgetSessions = (): void => found.clear();

/**
 * Is a Claude Code process running for this session id, by the session registry? Like the board's liveSessions, a file
 * counts only while its pid is alive and is the process that wrote it (a crashed session leaves its file, and its pid
 * can be reused).
 */
export function sessionLive(home: string, session: string, now = Date.now()): boolean {
  const dir = readSettings(home).board.sessionsDir;
  const key = `${dir}\0${session}`;
  const cached = found.get(key);
  if (cached && now - cached.at < SESSION_CACHE_MS) {
    return cached.live;
  }
  let live = false;
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((file) => /^\d+\.json$/.test(file))) {
      // a half-written entry reads as null
      const entry = readJson<{ sessionId?: unknown; pid?: unknown; procStart?: unknown }>(
        path.join(dir, name),
      );
      if (
        entry &&
        entry.sessionId === session &&
        Number.isInteger(entry.pid) &&
        sameProcess(entry.pid as number, entry.procStart)
      ) {
        live = true;
        break;
      }
    }
  }
  found.set(key, { at: now, live });
  return live;
}

/**
 * The story's binding while it can still be used: fresh, with a session that is still running. Null otherwise
 * (no binding, a stale one, one whose session is gone, or one that never knew its session).
 */
export function activeBinding(
  home: string,
  story: string | null | undefined,
  now = Date.now(),
): Binding | null {
  const binding = readBinding(home, story);
  if (!binding || !binding.session) {
    return null;
  }
  if (now - (Date.parse(binding.at) || 0) > BINDING_FRESH_MS) {
    return null;
  }
  return sessionLive(home, binding.session) ? binding : null;
}

/** The owner session relayed a question: the binding is in use, so its age starts again. */
export function touchBinding(home: string, story: string, now = Date.now()): void {
  const binding = readBinding(home, story);
  if (binding) {
    writeJsonAtomic(fileOf(home, story), { ...binding, at: new Date(now).toISOString() });
  }
}

/** The session this process runs under (a subagent has its parent's), or null. */
export const ownSession = (): string | null => process.env.CLAUDE_CODE_SESSION_ID || null;

/**
 * The binding a `wait --story` run from `session` relays: an active one owned by that very session, since only it can
 * message the agent. Null for any other session, which handles the story's questions itself.
 */
export function relayBinding(
  home: string,
  story: string,
  session: string | null = ownSession(),
  now = Date.now(),
): Binding | null {
  const binding = activeBinding(home, story, now);
  return binding && session && binding.session === session ? binding : null;
}
