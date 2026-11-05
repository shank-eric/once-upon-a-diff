/*
 * Checks a request body against its schema in the protocol (packages/protocol/src/schemas.ts, which assembles each
 * area's schemas) and returns it typed.
 * A route's handler calls it after the guards in index.ts have passed (the key, the story, the read-only list), so a
 * malformed body never changes which of 401, 403, 404, 413 or 415 a caller gets.
 */
import { checkBody, type BodyName, type Checked } from '@once-upon-a-diff/protocol/schemas';
import { HttpError } from './request.ts';

/** The body as its schema reads it, or a 400 with the schema's message. */
export function parseBody<Name extends BodyName>(
  name: Name,
  body: unknown,
): Extract<Checked<Name>, { ok: true }>['output'] {
  const checked = checkBody(name, body);
  if (!checked.ok) {
    throw new HttpError(400, checked.message);
  }
  return checked.output;
}
