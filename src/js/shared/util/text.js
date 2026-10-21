/*
 * Small text helpers shared by the panel, the content scripts and the bridge.
 * No DOM or Node dependencies.
 */

/** The 7-character short form of a commit SHA ('' for none). */
export function shortSha(sha) {
  return String(sha || '').slice(0, 7);
}

/** The last segment of a path: "src/app/main.js" -> "main.js". */
export function baseName(filePath) {
  return filePath.split('/').pop();
}

/** "1 file", "2 files": the count and the noun, with an "s" unless the count is 1. */
export function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The text with its first character upper-cased. */
export function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
