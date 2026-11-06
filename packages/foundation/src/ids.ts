/**
 * A fresh id for an inbox entry, a request or a backlog card: the prefix, the time in base 36 and 3 random bytes. A run's id
 * is minted here too, in its own form (`RUN_ID_RE` in domain/ids.ts). Where each key is read or built is domain/ids.ts.
 */
import { randomBytes } from 'node:crypto';

export const newId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

/** A fresh run id: `r_` and 10 hex digits. */
export const newRunId = (): string => `r_${randomBytes(5).toString('hex')}`;
