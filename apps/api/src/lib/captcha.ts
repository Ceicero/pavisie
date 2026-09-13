// Shared CAPTCHA provider resolution + server-side verification. Sole consumer is `/verify/:token` (the roles
// plugin's CAPTCHA verification mode). Donations no longer use CAPTCHA — the Stripe checkout endpoint that
// required one was removed when donations became a Ko-fi link-out (see docs/ARCHITECTURE.md §18).
import { env } from '@pavisie/core';

export interface ProviderConfig {
  id: 'hcaptcha' | 'turnstile';
  siteKey: string;
  secret: string;
  widgetScriptSrc: string;
  widgetClass: string;
  siteverifyUrl: string;
  csp: {
    script: string[];
    frame: string[];
    connect: string[];
    style: string[];
  };
}

/** Resolves the active CAPTCHA provider's public/secret keys and CSP allowlist from env, or `null` if unconfigured. */
export function resolveProvider(): ProviderConfig | null {
  if (env.CAPTCHA_PROVIDER === 'hcaptcha') {
    if (!env.HCAPTCHA_SITE_KEY || !env.HCAPTCHA_SECRET) return null;
    return {
      id: 'hcaptcha',
      siteKey: env.HCAPTCHA_SITE_KEY,
      secret: env.HCAPTCHA_SECRET,
      widgetScriptSrc: 'https://hcaptcha.com/1/api.js',
      widgetClass: 'h-captcha',
      siteverifyUrl: 'https://hcaptcha.com/siteverify',
      csp: {
        script: ['https://hcaptcha.com', 'https://*.hcaptcha.com'],
        frame: ['https://hcaptcha.com', 'https://*.hcaptcha.com'],
        connect: ['https://hcaptcha.com', 'https://*.hcaptcha.com'],
        style: ['https://hcaptcha.com', 'https://*.hcaptcha.com'],
      },
    };
  }
  if (env.CAPTCHA_PROVIDER === 'turnstile') {
    if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET) return null;
    return {
      id: 'turnstile',
      siteKey: env.TURNSTILE_SITE_KEY,
      secret: env.TURNSTILE_SECRET,
      widgetScriptSrc: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
      widgetClass: 'cf-turnstile',
      siteverifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      csp: {
        script: ['https://challenges.cloudflare.com'],
        frame: ['https://challenges.cloudflare.com'],
        connect: ['https://challenges.cloudflare.com'],
        style: [],
      },
    };
  }
  return null;
}

/**
 * Calls the provider's `siteverify` endpoint with the widget's response token and the server-side secret.
 * Never trusts the client's own claim of success — the human-solved-it signal only counts once this call
 * confirms it with the provider.
 */
export async function siteverify(
  provider: ProviderConfig,
  responseToken: string,
  remoteIp?: string,
): Promise<boolean> {
  const body = new URLSearchParams({ secret: provider.secret, response: responseToken });
  if (remoteIp) body.set('remoteip', remoteIp);

  const res = await fetch(provider.siteverifyUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) return false;
  const json = (await res.json().catch(() => null)) as { success?: boolean } | null;
  return json?.success === true;
}
