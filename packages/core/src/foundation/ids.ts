/** A fresh id for an inbox entry, a request or a backlog card: the prefix, the time in base 36 and 3 random bytes. */
import { randomBytes } from 'node:crypto';

export const newId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
