/*
 * Small text helpers shared by the panel, the content scripts, the pages and the bridge.
 * No DOM or Node dependencies, and no imports: the domain sits below the wire types.
 */

/** What gateText reads of a board agent (a BoardAgent fits): its name and the gate it is at, if any. */
interface GatedAgent {
  name: string;
  gate: { kind: 'plan' | 'review' | 'fixing'; findings: number | null } | null;
}

/** The 7-character short form of a commit SHA ('' for none). */
export function shortSha(sha: string | null | undefined): string {
  return String(sha || '').slice(0, 7);
}

/** The last segment of a path: "src/app/main.js" -> "main.js". */
export function baseName(filePath: string): string {
  return filePath.split('/').pop() as string;
}

/** The name half of an `owner/name` repo: "acme/widgets" -> "widgets" ('' for none). */
export function repoName(repo: string | null | undefined): string {
  return String(repo || '').split('/')[1] ?? '';
}

/** "1 file", "2 files": the count and the noun, with an "s" unless the count is 1. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** What an agent at a gate is doing, in a few words: "plan check", "fixing 5 findings", "agent review · review-x". */
export function gateText(agent: GatedAgent): string {
  const gate = agent.gate;
  if (gate?.kind === 'plan') {
    return 'plan check';
  }
  if (gate?.kind === 'fixing') {
    return gate.findings === null ? 'fixing' : `fixing ${plural(gate.findings, 'finding')}`;
  }
  return `agent review · ${agent.name}`;
}

/** Runs of whitespace (spaces, tabs, newlines) squeezed to single spaces, and the ends trimmed. */
export const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The text with its first character upper-cased. */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A commit SHA, full (SHA-1 or SHA-256) or abbreviated to 7 or more characters. */
export const SHA_RE = /^[0-9a-f]{7,64}$/;

/** Whether two SHAs name the same commit, either one maybe abbreviated. */
export function sameSha(
  first: string | null | undefined,
  second: string | null | undefined,
): boolean {
  return !!first && !!second && (first.startsWith(second) || second.startsWith(first));
}
