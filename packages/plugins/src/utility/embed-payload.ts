// Pure sanitisation/validation logic for `/embed builder` (kept free of discord.js interaction types so it's
// directly unit-testable — the Discord-facing wiring, including the async `assertPublicHttpUrl` image check,
// lives in `components/embed-builder.ts`).
import { EMBED_LIMITS, sanitizeEmbedText } from '@pavisie/core';

export class EmbedPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedPayloadError';
  }
}

/** The embed builder's editable fields — a small, deliberately flat subset of a full Discord embed. */
export interface EmbedBuilderPayload {
  title?: string;
  description?: string;
  colorHex?: string;
  imageUrl?: string;
  footer?: string;
}

export interface RawEmbedInput {
  title?: string | null;
  description?: string | null;
  colorHex?: string | null;
  imageUrl?: string | null;
  footer?: string | null;
}

const HEX_COLOR_PATTERN = /^#?[0-9a-fA-F]{6}$/;

/** Parses a `#RRGGBB` (or `RRGGBB`) string into a Discord embed color integer. Empty/undefined input returns `undefined`; anything else invalid throws. */
export function parseColorHex(input: string | null | undefined): number | undefined {
  const trimmed = input?.trim();
  if (!trimmed) return undefined;
  if (!HEX_COLOR_PATTERN.test(trimmed)) {
    throw new EmbedPayloadError(
      `"${input}" is not a valid hex color. Use a format like "#5865F2" or "5865F2".`,
    );
  }
  return parseInt(trimmed.replace(/^#/, ''), 16);
}

function sanitizeField(value: string | null | undefined, max: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return sanitizeEmbedText(trimmed, max);
}

/**
 * Sanitises raw embed-builder text input: trims, strips `@everyone`/`@here`/mentions (`sanitizeEmbedText`), and
 * truncates to Discord's embed field limits. Validates (but does not fetch) the color hex; image URL is
 * trimmed only here — the network-dependent SSRF check happens at the call site, since it's async I/O.
 */
export function sanitizeEmbedPayload(raw: RawEmbedInput): EmbedBuilderPayload {
  const colorHex = parseColorHex(raw.colorHex) !== undefined ? raw.colorHex!.trim() : undefined;

  return {
    title: sanitizeField(raw.title, EMBED_LIMITS.title),
    description: sanitizeField(raw.description, EMBED_LIMITS.description),
    colorHex,
    imageUrl: raw.imageUrl?.trim() || undefined,
    footer: sanitizeField(raw.footer, EMBED_LIMITS.footer),
  };
}

/** True if every field in `payload` is empty/undefined (nothing to preview or send). */
export function isPayloadEmpty(payload: EmbedBuilderPayload): boolean {
  return !payload.title && !payload.description && !payload.imageUrl && !payload.footer;
}

/**
 * Parses pasted embed JSON (the "Import JSON" flow). Accepts either this plugin's own flat shape
 * (`{ title, description, colorHex, imageUrl, footer }`) or a standard Discord embed JSON object
 * (`{ title, description, color, image: { url }, footer: { text } }`), normalizing either into
 * `EmbedBuilderPayload`. Throws `EmbedPayloadError` on invalid JSON or a value of the wrong type.
 */
export function embedPayloadFromJson(jsonText: string): EmbedBuilderPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new EmbedPayloadError('That is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EmbedPayloadError('Expected a JSON object.');
  }
  const obj = parsed as Record<string, unknown>;

  function stringField(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new EmbedPayloadError(`"${field}" must be a string.`);
    return value;
  }

  const title = stringField(obj.title, 'title');
  const description = stringField(obj.description, 'description');

  let colorHex: string | undefined;
  if (typeof obj.colorHex === 'string') {
    colorHex = obj.colorHex;
  } else if (typeof obj.color === 'number') {
    colorHex = `#${obj.color.toString(16).padStart(6, '0')}`;
  } else if (typeof obj.color === 'string') {
    colorHex = obj.color;
  }

  let imageUrl: string | undefined;
  if (typeof obj.imageUrl === 'string') {
    imageUrl = obj.imageUrl;
  } else if (
    obj.image &&
    typeof obj.image === 'object' &&
    typeof (obj.image as Record<string, unknown>).url === 'string'
  ) {
    imageUrl = (obj.image as Record<string, unknown>).url as string;
  }

  let footer: string | undefined;
  if (typeof obj.footer === 'string') {
    footer = obj.footer;
  } else if (
    obj.footer &&
    typeof obj.footer === 'object' &&
    typeof (obj.footer as Record<string, unknown>).text === 'string'
  ) {
    footer = (obj.footer as Record<string, unknown>).text as string;
  }

  return sanitizeEmbedPayload({ title, description, colorHex, imageUrl, footer });
}
