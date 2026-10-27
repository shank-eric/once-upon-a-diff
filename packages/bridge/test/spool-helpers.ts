/*
 * What the review inbox's tests share: a git checkout, Claude Code transcripts, and the capture hook run the way Claude
 * Code runs it (its JSON on stdin), with the bridge reading the spool it writes.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, git } from './helpers.ts';
import type { TestBridge } from './helpers.ts';

export const HOOK = fileURLToPath(
  new URL('../../../skills/once-upon/bin/capture-turn.sh', import.meta.url),
);

/** A checkout with one commit, on branch main, whose origin is acme/widgets. */
export function checkout(): string {
  const repo = tmp('turns-repo');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'one.txt'), 'a\nb\nc\n');
  writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  return repo;
}

/** One line of a transcript, stamped `ago` ms before now. */
export interface Said {
  kind:
    | 'prompt'
    | 'human'
    | 'notification'
    | 'assistant'
    | 'tool_use'
    | 'tool_result'
    | 'interrupt'
    | 'meta'
    | 'sidechain';
  ago: number;
  text?: string;
  /** the assistant message the line belongs to */
  message?: string;
}

/**
 * A transcript named for its session, as Claude Code names it, with these lines (and a line that isn't JSON). A `prompt`
 * has no origin, as in older versions; a `human` one has.
 */
export function transcriptFile(session: string, said: Said[]): string {
  const file = path.join(tmp('turns-transcript'), `${session}.jsonl`);
  const stamp = (ago: number) => new Date(Date.now() - ago).toISOString();
  const lines = said.map((line) => {
    const timestamp = stamp(line.ago);
    switch (line.kind) {
      case 'prompt':
        return { type: 'user', timestamp, message: { role: 'user', content: line.text } };
      case 'human':
        // as current Claude Code writes what you typed: with its origin
        return {
          type: 'user',
          origin: { kind: 'human' },
          timestamp,
          message: { role: 'user', content: line.text },
        };
      case 'notification':
        // a finished background task, which arrives as a user line too
        return {
          type: 'user',
          origin: { kind: 'task-notification' },
          timestamp,
          message: {
            role: 'user',
            content: `<task-notification><task-id>${line.text}</task-id></task-notification>`,
          },
        };
      case 'meta':
        return {
          type: 'user',
          isMeta: true,
          timestamp,
          message: { role: 'user', content: line.text },
        };
      case 'sidechain':
        return {
          type: 'user',
          isSidechain: true,
          timestamp,
          message: { role: 'user', content: [{ type: 'text', text: line.text }] },
        };
      case 'interrupt':
        return {
          type: 'user',
          timestamp,
          message: {
            role: 'user',
            content: [{ type: 'text', text: '[Request interrupted by user]' }],
          },
        };
      case 'tool_use':
        return {
          type: 'assistant',
          timestamp,
          message: {
            id: line.message || 'msg_tool',
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: {} }],
          },
        };
      case 'tool_result':
        return {
          type: 'user',
          timestamp,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }],
          },
        };
      default:
        return {
          type: 'assistant',
          timestamp,
          message: {
            id: line.message || 'msg_text',
            role: 'assistant',
            content: [{ type: 'text', text: line.text }],
          },
        };
    }
  });
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\nnot json at all\n');
  return file;
}

/**
 * A Claude Code transcript for a session: an earlier prompt, then this turn's prompt (2 s ago), a tool call and its result,
 * and Claude's last message.
 */
export function transcript(prompt: string, session = 'sess-1', summary = 'Renamed it.'): string {
  return transcriptFile(session, [
    { kind: 'prompt', ago: 3600000, text: 'an earlier prompt' },
    { kind: 'assistant', ago: 3590000, text: 'ok', message: 'msg_old' },
    { kind: 'prompt', ago: 2000, text: prompt },
    { kind: 'tool_use', ago: 1800 },
    { kind: 'tool_result', ago: 1500 },
    { kind: 'assistant', ago: 1000, text: summary, message: 'msg_last' },
  ]);
}

/** Runs the hook the way Claude Code does: its JSON on stdin. */
export function runHook(
  home: string,
  input: unknown,
  env: Record<string, string> = {},
  shell = 'bash',
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(shell, [HOOK], {
      env: { ...process.env, ONCE_UPON_HOME: home, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

/** The hook's input for a Stop. */
export const stop = (repo: string, extra: Record<string, unknown> = {}) => {
  const session = String(extra.session_id ?? 'sess-1');
  return {
    hook_event_name: 'Stop',
    session_id: session,
    cwd: repo,
    transcript_path: transcript('Rename b to B in one.txt', session),
    ...extra,
  };
};

/** The hook's input for a prompt: its snapshot is the turn's start. */
export const prompt = (repo: string, extra: Record<string, unknown> = {}) =>
  stop(repo, { hook_event_name: 'UserPromptSubmit', ...extra });

/** Runs the hook, then has the bridge read the spool. */
export async function ran(bridge: TestBridge, home: string, input: unknown) {
  const result = await runHook(home, input);
  await bridge.server.spool.drain();
  return result;
}

/** The records in a home's spool. */
export const spoolLines = (home: string): Record<string, unknown>[] => {
  const file = path.join(home, 'turns', 'incoming.jsonl');
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
};
