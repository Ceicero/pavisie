import { describe, expect, it } from 'vitest';
import { EMBED_LIMITS } from '@pavisie/core';
import {
  embedPayloadFromJson,
  EmbedPayloadError,
  isPayloadEmpty,
  parseColorHex,
  sanitizeEmbedPayload,
} from '../embed-payload';

describe('parseColorHex', () => {
  it('parses "#RRGGBB" and bare "RRGGBB"', () => {
    expect(parseColorHex('#5865F2')).toBe(0x5865f2);
    expect(parseColorHex('5865F2')).toBe(0x5865f2);
  });

  it('returns undefined for empty/undefined input', () => {
    expect(parseColorHex(undefined)).toBeUndefined();
    expect(parseColorHex(null)).toBeUndefined();
    expect(parseColorHex('')).toBeUndefined();
    expect(parseColorHex('   ')).toBeUndefined();
  });

  it('throws for an invalid hex string', () => {
    expect(() => parseColorHex('not-a-color')).toThrow(EmbedPayloadError);
    expect(() => parseColorHex('#12345')).toThrow(EmbedPayloadError);
    expect(() => parseColorHex('#gggggg')).toThrow(EmbedPayloadError);
  });
});

describe('sanitizeEmbedPayload', () => {
  it('trims whitespace and drops empty fields', () => {
    const payload = sanitizeEmbedPayload({
      title: '  Hello  ',
      description: '',
      footer: null,
      imageUrl: undefined,
      colorHex: '  ',
    });
    expect(payload.title).toBe('Hello');
    expect(payload.description).toBeUndefined();
    expect(payload.footer).toBeUndefined();
    expect(payload.imageUrl).toBeUndefined();
    expect(payload.colorHex).toBeUndefined();
  });

  it('strips @everyone/@here and mention syntax from text fields', () => {
    const payload = sanitizeEmbedPayload({
      title: 'Hey @everyone',
      description: 'Ping <@123456789012345678> and <@&98765432109876543>',
    });
    expect(payload.title).not.toContain('@everyone');
    expect(payload.description).not.toContain('<@123456789012345678>');
  });

  it('truncates text fields to Discord embed limits', () => {
    const payload = sanitizeEmbedPayload({
      title: 'x'.repeat(500),
      description: 'y'.repeat(5000),
      footer: 'z'.repeat(3000),
    });
    expect(payload.title!.length).toBeLessThanOrEqual(EMBED_LIMITS.title);
    expect(payload.description!.length).toBeLessThanOrEqual(EMBED_LIMITS.description);
    expect(payload.footer!.length).toBeLessThanOrEqual(EMBED_LIMITS.footer);
  });

  it('throws for an invalid color hex', () => {
    expect(() => sanitizeEmbedPayload({ colorHex: 'not-a-color' })).toThrow(EmbedPayloadError);
  });
});

describe('isPayloadEmpty', () => {
  it('is true when nothing is set', () => {
    expect(isPayloadEmpty({})).toBe(true);
    expect(isPayloadEmpty({ colorHex: '#ffffff' })).toBe(true); // color alone isn't a visible embed
  });

  it('is false when any visible field is set', () => {
    expect(isPayloadEmpty({ title: 'x' })).toBe(false);
    expect(isPayloadEmpty({ description: 'x' })).toBe(false);
    expect(isPayloadEmpty({ imageUrl: 'https://example.com/x.png' })).toBe(false);
    expect(isPayloadEmpty({ footer: 'x' })).toBe(false);
  });
});

describe('embedPayloadFromJson', () => {
  it('accepts the flat plugin shape', () => {
    const payload = embedPayloadFromJson(
      JSON.stringify({
        title: 'T',
        description: 'D',
        colorHex: '#ff0000',
        imageUrl: 'https://example.com/i.png',
        footer: 'F',
      }),
    );
    expect(payload).toMatchObject({
      title: 'T',
      description: 'D',
      colorHex: '#ff0000',
      imageUrl: 'https://example.com/i.png',
      footer: 'F',
    });
  });

  it('accepts a standard Discord embed JSON shape (numeric color, nested image/footer)', () => {
    const payload = embedPayloadFromJson(
      JSON.stringify({
        title: 'T',
        color: 0x00ff00,
        image: { url: 'https://example.com/i.png' },
        footer: { text: 'F' },
      }),
    );
    expect(payload.title).toBe('T');
    expect(payload.colorHex).toBe('#00ff00');
    expect(payload.imageUrl).toBe('https://example.com/i.png');
    expect(payload.footer).toBe('F');
  });

  it('sanitizes imported text the same way as manual input', () => {
    const payload = embedPayloadFromJson(JSON.stringify({ title: 'Hey @everyone' }));
    expect(payload.title).not.toContain('@everyone');
  });

  it('throws EmbedPayloadError for invalid JSON', () => {
    expect(() => embedPayloadFromJson('{ not json')).toThrow(EmbedPayloadError);
  });

  it('throws EmbedPayloadError for a JSON array or primitive', () => {
    expect(() => embedPayloadFromJson('[1,2,3]')).toThrow(EmbedPayloadError);
    expect(() => embedPayloadFromJson('"just a string"')).toThrow(EmbedPayloadError);
  });

  it('throws EmbedPayloadError when a known field has the wrong type', () => {
    expect(() => embedPayloadFromJson(JSON.stringify({ title: 12345 }))).toThrow(EmbedPayloadError);
  });
});
