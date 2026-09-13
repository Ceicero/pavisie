import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ZodFastifyInstance } from '../lib/http';
import { redisKey } from '@pavisie/core';
import { resolveProvider, siteverify, type ProviderConfig } from '../lib/captcha';

const VERIFY_DONE_TTL_SECONDS = 120;

const tokenParamSchema = z.object({ token: z.string().min(1) });
const verifyBodySchema = z.object({ response: z.string().min(1) });

function cspHeader(provider: ProviderConfig, nonce: string): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'self'"],
    'script-src': ["'self'", `'nonce-${nonce}'`, ...provider.csp.script],
    'style-src': ["'self'", "'unsafe-inline'", ...provider.csp.style],
    'frame-src': [...provider.csp.frame],
    'connect-src': ["'self'", ...provider.csp.connect],
    'img-src': ["'self'", 'data:'],
  };
  return Object.entries(directives)
    .filter(([, values]) => values.length > 0)
    .map(([directive, values]) => `${directive} ${values.join(' ')}`)
    .join('; ');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pageShell(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Pavisie Verification</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0b0d10; color: #e6e8eb; font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
  .card { max-width: 420px; width: calc(100% - 3rem); margin: 1.5rem; padding: 2rem; border-radius: 12px; background: #16191d; border: 1px solid #2a2f36; text-align: center; }
  h1 { font-size: 1.15rem; margin: 0 0 0.75rem; }
  p { color: #a5abb3; margin: 0 0 1.25rem; }
  .widget-wrap { display: flex; justify-content: center; margin-bottom: 1rem; }
  .status { font-size: 0.9rem; min-height: 1.2em; }
  .status.ok { color: #4ade80; }
  .status.err { color: #f87171; }
</style>
</head>
<body>
<div class="card">${body}</div>
</body>
</html>`;
}

function expiredPage(): string {
  return pageShell(
    `<h1>Link expired</h1><p>This verification link is invalid or has expired. Go back to Discord and run <strong>/verify</strong> again to get a fresh link.</p>`,
  );
}

function notConfiguredPage(): string {
  return pageShell(
    `<h1>Verification unavailable</h1><p>CAPTCHA verification is not configured on this bot instance. Please contact the server's staff.</p>`,
  );
}

function widgetPage(provider: ProviderConfig, token: string, nonce: string): string {
  return pageShell(`
<h1>You're almost in</h1>
<p>Complete the challenge below to finish verifying.</p>
<div class="widget-wrap">
  <div class="${provider.widgetClass}" data-sitekey="${escapeHtml(provider.siteKey)}" data-callback="onVerify"></div>
</div>
<p class="status" id="status"></p>
<script src="${provider.widgetScriptSrc}" async defer></script>
<script nonce="${nonce}">
  var token = ${JSON.stringify(token)};
  window.onVerify = function (captchaResponse) {
    var statusEl = document.getElementById('status');
    statusEl.textContent = 'Verifying…';
    statusEl.className = 'status';
    fetch(window.location.pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response: captchaResponse }),
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (result) {
        if (result.ok && result.body && result.body.ok) {
          statusEl.textContent = "Verified! You're all set — head back to Discord.";
          statusEl.className = 'status ok';
        } else {
          statusEl.textContent = (result.body && result.body.error) || 'Verification failed. Refresh and try again.';
          statusEl.className = 'status err';
        }
      })
      .catch(function () {
        statusEl.textContent = 'Something went wrong. Refresh and try again.';
        statusEl.className = 'status err';
      });
  };
</script>`);
}

/**
 * `/verify/:token` — the public CAPTCHA completion page for the `roles` plugin's CAPTCHA verification mode
 * (README.md "Known integration gap"). `/verify` slash command writes `pavisie:verify:pending:<token>` in
 * Redis (`{guildId, userId}`, 10-minute TTL); this page solves the widget, verifies the response server-side
 * with the configured provider's `siteverify` endpoint, then writes `pavisie:verify:done:<token>`, which the
 * `roles` plugin's `captcha-poll` job (every 15s) picks up to grant the verified role and clean up both keys.
 * Not session-authenticated — this is a public, unauthenticated page reachable by anyone with the link.
 * Registered under a strict per-route CSP (the app-wide helmet CSP is disabled since every other route here
 * serves JSON, not HTML).
 */
export default async function verifyRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/:token',
    { schema: { params: tokenParamSchema }, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const provider = resolveProvider();
      if (!provider) {
        reply.status(404);
        reply.type('text/html; charset=utf-8');
        return notConfiguredPage();
      }

      const { token } = request.params;
      const pending = await app.redis.get(redisKey('verify', 'pending', token));
      const nonce = randomBytes(16).toString('base64');
      reply.header('Content-Security-Policy', cspHeader(provider, nonce));
      reply.header('X-Frame-Options', 'DENY');
      reply.type('text/html; charset=utf-8');

      if (!pending) {
        reply.status(410);
        return expiredPage();
      }

      return widgetPage(provider, token, nonce);
    },
  );

  app.post(
    '/:token',
    {
      schema: { params: tokenParamSchema, body: verifyBodySchema },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply): Promise<{ ok: boolean; error?: string }> => {
      const provider = resolveProvider();
      if (!provider) {
        reply.status(404);
        return { ok: false, error: 'CAPTCHA verification is not configured on this bot instance.' };
      }

      const { token } = request.params;
      const pendingKey = redisKey('verify', 'pending', token);
      const pending = await app.redis.get(pendingKey);
      if (!pending) {
        reply.status(410);
        return { ok: false, error: 'This verification link is invalid or has expired.' };
      }

      const verified = await siteverify(provider, request.body.response, request.ip);
      if (!verified) {
        reply.status(400);
        return { ok: false, error: 'CAPTCHA challenge could not be verified. Please try again.' };
      }

      // The `captcha-poll` job (roles plugin) scans for this key, resolves guild/user context from the
      // matching pending key (or this value as a fallback), grants the verified role, then deletes both keys.
      await app.redis.set(redisKey('verify', 'done', token), pending, 'EX', VERIFY_DONE_TTL_SECONDS);

      return { ok: true };
    },
  );
}
