/*
 * Small helpers the backstory modules share: the home folder, a minute, text
 * clipped for a brief, and ISO times as milliseconds.
 */
import os from 'node:os';

export const HOME = os.homedir();
export const MIN = 60 * 1000;
export const clip = (text, max) => {
  const trimmed = String(text || '')
    .replace(/\s+\n/g, '\n')
    .trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
};
export const toMillis = (iso) => (iso ? Date.parse(iso) : NaN);
