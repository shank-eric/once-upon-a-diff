/** A route table and the body schemas as plain, ordered data, so a snapshot can be compared and diffed. */
import type { AnyRoute } from '../src/routes.ts';

/** A valibot schema (or any value) as JSON: regexes by source, functions by their source, without spacing, and the key order kept. */
export function plain(value: unknown): unknown {
  if (value instanceof RegExp) {
    return { regex: value.toString() };
  }
  if (typeof value === 'function') {
    return { function: value.toString().replace(/\s+|,(?=[)}\]])/g, '') };
  }
  if (Array.isArray(value)) {
    return value.map(plain);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, one]) => !key.startsWith('~') && key !== 'reference' && one !== undefined)
        .map(([key, one]) => [key, plain(one)]),
    );
  }
  return value;
}

export const snapshotOf = (routes: Record<string, AnyRoute>, bodies: Record<string, unknown>) => ({
  routes: Object.entries(routes).map(([name, route]) => [
    name,
    route.method,
    route.path,
    route.what ?? null,
    route.sub ?? null,
    route.keys,
  ]),
  bodies: Object.entries(bodies).map(([name, schema]) => [name, plain(schema)]),
});
