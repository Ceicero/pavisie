import { z } from 'zod';

/** Minimal JSON-Schema-ish description of a zod type, good enough for the dashboard to auto-render a config form. */
export interface JsonSchemaLike {
  type?: string;
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  items?: JsonSchemaLike;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchemaLike[];
  additionalProperties?: JsonSchemaLike | boolean;
  description?: string;
  default?: unknown;
  nullable?: boolean;
  optional?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  [extra: string]: unknown;
}

/**
 * Converts a zod schema into a small JSON-Schema-ish object covering the shapes plugin `configSchema`s
 * actually use: object/string/number/boolean/enum/array/nullable/optional/default/describe (plus record,
 * literal, and union as a convenience). Not a full JSON Schema implementation — purpose-built for
 * `GET /guilds/:guildId/plugins/:pluginId/config-schema` so the dashboard can auto-render a form.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchemaLike {
  const description = schema.description ? { description: schema.description } : {};

  // zod 4: `.prefault()` is the v3-style "default applied before parsing" used by plugin manifests.
  if (schema instanceof z.ZodDefault || schema instanceof z.ZodPrefault) {
    const inner = zodToJsonSchema(schema.def.innerType as z.ZodTypeAny);
    const raw = (schema.def as { defaultValue: unknown }).defaultValue;
    return { ...inner, default: typeof raw === 'function' ? (raw as () => unknown)() : raw, ...description };
  }

  if (schema instanceof z.ZodOptional) {
    const inner = zodToJsonSchema(schema.def.innerType as z.ZodTypeAny);
    return { ...inner, optional: true, ...description };
  }

  if (schema instanceof z.ZodNullable) {
    const inner = zodToJsonSchema(schema.def.innerType as z.ZodTypeAny);
    return { ...inner, nullable: true, ...description };
  }

  // zod 4: `.transform()`/`.pipe()` produce a ZodPipe (refinements no longer wrap); describe the input side.
  if (schema instanceof z.ZodPipe) {
    return { ...zodToJsonSchema(schema.def.in as z.ZodTypeAny), ...description };
  }

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, JsonSchemaLike> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      const isOptional =
        value instanceof z.ZodOptional || value instanceof z.ZodDefault || value instanceof z.ZodPrefault;
      if (!isOptional) required.push(key);
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      ...description,
    };
  }

  if (schema instanceof z.ZodString) {
    const min = schema.minLength ?? undefined;
    const max = schema.maxLength ?? undefined;
    return {
      type: 'string',
      ...(min !== undefined ? { minLength: min } : {}),
      ...(max !== undefined ? { maxLength: max } : {}),
      ...description,
    };
  }

  if (schema instanceof z.ZodNumber) {
    const min = Number.isFinite(schema.minValue) ? (schema.minValue as number) : undefined;
    const max = Number.isFinite(schema.maxValue) ? (schema.maxValue as number) : undefined;
    return {
      type: 'number',
      ...(min !== undefined ? { minimum: min } : {}),
      ...(max !== undefined ? { maximum: max } : {}),
      ...description,
    };
  }

  if (schema instanceof z.ZodBoolean) {
    return { type: 'boolean', ...description };
  }

  // zod 4 merged ZodNativeEnum into ZodEnum.
  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: schema.options as unknown[], ...description };
  }

  if (schema instanceof z.ZodLiteral) {
    const values = [...schema.values];
    return values.length === 1 ? { const: values[0], ...description } : { enum: values, ...description };
  }

  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: zodToJsonSchema(schema.element as z.ZodTypeAny), ...description };
  }

  if (schema instanceof z.ZodRecord) {
    return {
      type: 'object',
      additionalProperties: zodToJsonSchema(schema.valueType as z.ZodTypeAny),
      ...description,
    };
  }

  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    const list = (schema.options ?? []) as readonly z.ZodTypeAny[];
    return { anyOf: list.map((option) => zodToJsonSchema(option)), ...description };
  }

  return { type: 'unknown', ...description };
}
