/** Product branding constants used across embeds, dashboard, and README generation. */
export const BRAND = {
  name: 'Pavisie',
  color: 0xc7933d, // gold-5 — the primary accent on the dark theme (docs/ARCHITECTURE.md §20)
  tagline: 'The modular, compliance-first Discord bot',
  docsUrl: 'https://github.com/',
  siteUrl: 'https://pavisie.com',
} as const;

/**
 * Builds the public URL of the brand logo (skull) for use as an embed author/footer icon,
 * or `undefined` when `env.WEB_URL` is not set (embeds then omit the icon rather than link
 * to a URL that may not exist). See docs/ARCHITECTURE.md §22.
 */
export function brandIconUrl(env: { WEB_URL?: string; BRAND_LOGO_PATH?: string }): string | undefined {
  if (!env.WEB_URL) return undefined;
  return `${env.WEB_URL}${env.BRAND_LOGO_PATH ?? '/brand/pavisie-skull.png'}`;
}

/** Discord embed field/content limits (bytes are UTF-16 code units per Discord's API docs). */
export const EMBED_LIMITS = {
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  total: 6000,
} as const;

/** Maximum length of a Discord component custom_id. */
export const CUSTOM_ID_MAX = 100;
