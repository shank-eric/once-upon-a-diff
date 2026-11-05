/*
 * The request-body schemas, one per route that takes a body (routes.ts names them in BODIES). The bridge checks every
 * body against its schema, so a handler reads typed values and never `String(body.x || '')`. Server side only: it
 * imports valibot, so the bridge never serves this file to a page, and routes.ts takes the body types from it with
 * `import type`, which is erased. A page or the extension therefore never loads valibot.
 *
 * This file is the index. The schemas are in each area's folder (bridge/, story/, board/, github/ schemas.ts), built
 * with the readers in schema-kit.ts, and BODIES is assembled here. Every schema is an `object`, which drops fields it
 * doesn't list. Where the server used to take anything and quietly fall back to a default (page settings, the panel's
 * saved state), the schema says so with `fallback` and the answer doesn't change. Where a handler had a message the page
 * shows, each area's MESSAGES carries the same text.
 */
import { safeParse, type InferOutput } from 'valibot';
import { BRIDGE_BODIES, BRIDGE_MESSAGES } from './bridge/schemas.ts';
import { STORY_BODIES, STORY_MESSAGES } from './story/schemas.ts';
import { BOARD_BODIES, BOARD_MESSAGES } from './board/schemas.ts';
import { GITHUB_BODIES, GITHUB_MESSAGES } from './github/schemas.ts';

export { GITHUB_REFRESH_REASONS } from './github/schemas.ts';

// The order is the one the bodies have always had (the extension's refresh body comes last), which a test pins.
export const BODIES = {
  ...BRIDGE_BODIES,
  ...STORY_BODIES,
  ...BOARD_BODIES,
  ...GITHUB_BODIES,
};

/** The name of a body schema in BODIES. */
export type BodyName = keyof typeof BODIES;

/**
 * What the bridge has always said about a field, where a page shows it, by body and field. Valibot's own message for
 * a missing key doesn't name the field, so the message comes from here.
 */
const FIELD_MESSAGES: Partial<Record<BodyName, Record<string, string>>> = {
  ...BRIDGE_MESSAGES,
  ...STORY_MESSAGES,
  ...BOARD_MESSAGES,
  ...GITHUB_MESSAGES,
};

/** What checkBody says: the body as the schema reads it, or why it can't. */
export type Checked<Name extends BodyName> =
  { ok: true; output: InferOutput<(typeof BODIES)[Name]> } | { ok: false; message: string };

/**
 * Checks a body against one of the schemas. A field the bridge has a message for says it (FIELD_MESSAGES), a check's own
 * message goes out as it is, and valibot's own wording, which echoes the value it got, becomes "<field> is not valid".
 */
export function checkBody<Name extends BodyName>(name: Name, body: unknown): Checked<Name> {
  const result = safeParse(BODIES[name], body);
  if (result.success) {
    return { ok: true, output: result.output as InferOutput<(typeof BODIES)[Name]> };
  }
  const [issue] = result.issues;
  const field = String(issue.path?.[0]?.key ?? '');
  const said = FIELD_MESSAGES[name]?.[field];
  if (said) {
    return { ok: false, message: said };
  }
  const where = (issue.path || []).map((step) => String(step.key)).join('.') || 'the body';
  return {
    ok: false,
    message: issue.message.startsWith('Invalid ') ? `${where} is not valid` : issue.message,
  };
}
