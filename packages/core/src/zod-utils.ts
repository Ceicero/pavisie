import { z } from 'zod';

/**
 * zod 4 changed `.partial()` semantics: a field that has `.default(x)` / `.prefault(x)` still fills in `x` when the
 * key is absent, even after `.partial()`. For PATCH/PUT-style update bodies that silently resets every omitted
 * field to its default. This builds the zod-3-equivalent "update" schema: every key optional, defaults stripped,
 * so omitted keys stay omitted.
 */
export function partialWithoutDefaults<S extends z.ZodObject>(schema: S): ReturnType<S['partial']> {
  const shape: Record<string, z.ZodOptional<z.ZodTypeAny>> = {};
  for (const [key, value] of Object.entries(schema.shape) as [string, z.ZodTypeAny][]) {
    let inner: z.ZodTypeAny = value;
    while (
      inner instanceof z.ZodDefault ||
      inner instanceof z.ZodPrefault ||
      inner instanceof z.ZodOptional
    ) {
      inner = inner.def.innerType as z.ZodTypeAny;
    }
    shape[key] = inner.optional();
  }
  return z.object(shape) as unknown as ReturnType<S['partial']>;
}
