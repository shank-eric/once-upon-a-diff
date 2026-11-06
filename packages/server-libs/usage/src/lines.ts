/*
 * V8's coverage as lines, kept small: for each file, a bitset with one bit per line, set when the line was NOT run (a
 * count-0 range covers every non-blank character on it). Pure: the source text is handed in.
 */
import { createHash } from 'node:crypto';
import type { CoverageFunction } from './adapters/session.ts';

/** The first 8 hex characters of the text's sha1: names a version of a file. */
export const shaOf = (text: string): string =>
  createHash('sha1').update(text).digest('hex').slice(0, 8);

/** How many lines the text has (the last line counts even without a final newline). */
export const lineCount = (text: string): number => {
  let total = 1;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) {
      total++;
    }
  }
  return text.endsWith('\n') ? total - 1 : total;
};

/** How many lines of the text have something on them besides whitespace. */
export const nonBlankLines = (text: string): number =>
  text.split('\n').filter((line) => line.trim() !== '').length;

/** A packed bitset of `lines` bits: bit i is line i + 1. */
export const emptyBits = (lines: number): Uint8Array => new Uint8Array(Math.ceil(lines / 8));
export const getBit = (bits: Uint8Array, line: number): boolean =>
  ((bits[line >> 3] >> (line & 7)) & 1) === 1;
const setBit = (bits: Uint8Array, line: number): void => {
  bits[line >> 3] |= 1 << (line & 7);
};
export const countBits = (bits: Uint8Array): number => {
  let total = 0;
  for (const byte of bits) {
    let rest = byte;
    while (rest) {
      total += rest & 1;
      rest >>= 1;
    }
  }
  return total;
};
export const toBase64 = (bits: Uint8Array): string => Buffer.from(bits).toString('base64');
export const fromBase64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64'));

/** A line is uncovered in the result only if it is uncovered in both: a run anywhere covered it otherwise. */
export function andBits(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.max(left.length, right.length));
  for (let index = 0; index < out.length; index++) {
    out[index] = (left[index] ?? 0) & (right[index] ?? 0);
  }
  return out;
}

/**
 * The lines of `text` that V8 says did not run. Ranges are painted outermost first (by start, longest first), so an inner
 * range's count wins over the function around it. A line with only whitespace is never uncovered.
 */
export function uncoveredLines(text: string, functions: CoverageFunction[]): Uint8Array {
  const lines = lineCount(text);
  const zero = new Uint8Array(text.length);
  const ranges = functions
    .flatMap((func) => func.ranges)
    .sort(
      (left, right) => left.startOffset - right.startOffset || right.endOffset - left.endOffset,
    );
  for (const range of ranges) {
    zero.fill(range.count === 0 ? 1 : 0, range.startOffset, Math.min(range.endOffset, text.length));
  }
  const bits = emptyBits(lines);
  let line = 0;
  let sawCode = false;
  let allZero = true;
  const close = () => {
    if (sawCode && allZero) {
      setBit(bits, line);
    }
    line++;
    sawCode = false;
    allZero = true;
  };
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 10) {
      close();
    } else if (code !== 32 && code !== 9 && code !== 13) {
      sawCode = true;
      if (zero[i] === 0) {
        allZero = false;
      }
    }
  }
  if (line < lines) {
    close();
  }
  return bits;
}
