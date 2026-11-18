/* The two readers every file schema shares: a field no reader depends on, and the schema as a reader that returns the value or null. Valibot only. */
import {
  fallback,
  nullable,
  optional,
  safeParse,
  type GenericSchema,
  type InferOutput,
} from 'valibot';

/** A field no reader depends on: absent, null, or of the wrong type reads as absent (null stays null). */
export const lenient = <S extends GenericSchema>(schema: S) =>
  optional(fallback(nullable(schema), undefined));
/** The value the schema accepts, or null. */
export const reader =
  <S extends GenericSchema>(schema: S) =>
  (value: unknown): InferOutput<S> | null => {
    const result = safeParse(schema, value);
    return result.success ? result.output : null;
  };
