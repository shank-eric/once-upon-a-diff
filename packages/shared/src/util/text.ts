/*
 * Small text helpers shared by the panel, the content scripts and the bridge.
 * No DOM or Node dependencies.
 */
import type { BoardAgent } from '../types.ts';

/** The 7-character short form of a commit SHA ('' for none). */
export function shortSha(sha: string | null | undefined): string {
  return String(sha || '').slice(0, 7);
}

/** The last segment of a path: "src/app/main.js" -> "main.js". */
export function baseName(filePath: string): string {
  return filePath.split('/').pop() as string;
}

/** "1 file", "2 files": the count and the noun, with an "s" unless the count is 1. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** What an agent at a gate is doing, in a few words: "plan check", "fixing 5 findings", "agent review · review-x". */
export function gateText(agent: Pick<BoardAgent, 'name' | 'gate'>): string {
  const gate = agent.gate;
  if (gate?.kind === 'plan') {
    return 'plan check';
  }
  if (gate?.kind === 'fixing') {
    return gate.findings === null ? 'fixing' : `fixing ${plural(gate.findings, 'finding')}`;
  }
  return `agent review · ${agent.name}`;
}

/** The text with its first character upper-cased. */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A commit SHA, full or abbreviated to 7 or more characters. */
export const SHA_RE = /^[0-9a-f]{7,40}$/;

/** Whether two SHAs name the same commit, either one maybe abbreviated. */
export function sameSha(
  first: string | null | undefined,
  second: string | null | undefined,
): boolean {
  return !!first && !!second && (first.startsWith(second) || second.startsWith(first));
}
