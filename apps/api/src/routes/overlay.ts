import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ZodFastifyInstance } from '../lib/http';
import { redisKey } from '@pavisie/core';
import { registerOverlayConnection, unregisterOverlayConnection } from '../lib/overlay-registry';
import { resolveOverlayChannelId } from '../lib/overlay-token';

const tokenParamSchema = z.object({ token: z.string().min(1) });
// audioId is generated server-side (uuid/cuid-shaped) and interpolated straight into a Redis key
// (`pavisie:overlay:tts:<audioId>`) below — pin it to a safe id alphabet before it ever reaches Redis.
const ttsParamSchema = z.object({
  token: z.string().min(1),
  audioId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});

const PING_INTERVAL_MS = 20_000;

function cspHeader(nonce: string): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'script-src': [`'nonce-${nonce}'`],
    'style-src': ["'self'", "'unsafe-inline'"],
    // EventSource is same-origin fetch under the hood — needs explicit connect-src since default-src is 'none'.
    'connect-src': ["'self'"],
    // 'self' for the ./tts/:audioId route, https: for admin-supplied sound URLs (assertPublicHttpUrl-checked
    // at write time), data:/blob: because some browsers resolve <audio> sources through one of those first.
    'media-src': ["'self'", 'https:', 'data:', 'blob:'],
  };
  return Object.entries(directives)
    .map(([directive, values]) => `${directive} ${values.join(' ')}`)
    .join('; ');
}

function pageShell(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Pavisie Overlay</title>
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  body { width: 100vw; height: 100vh; overflow: hidden; }
  .msg { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; font: 14px system-ui, -apple-system, Segoe UI, sans-serif; color: #888; opacity: 0.6; }
</style>
</head>
<body>${body}</body>
</html>`;
}

function expiredPage(): string {
  return pageShell(`<div class="msg">This overlay link is no longer valid.</div>`);
}

// No token, user text, or any other request-derived value is ever interpolated into this markup — only the
// per-request nonce (our own `randomBytes(16).toString('base64')` output, never attacker-controlled) — so
// there is nothing here that needs HTML-escaping.
function overlayPage(nonce: string): string {
  return pageShell(`
<script nonce="${nonce}">
(function () {
  var queue = [];
  var playing = false;
  var seen = new Set();
  var seenOrder = [];
  var MAX_SEEN = 200;

  // Marks id seen; returns true the FIRST time an id is passed (i.e. "not a duplicate"). A reconnecting
  // EventSource has no memory of what already played, so this is what stops a reconnect from replaying alerts.
  function markSeenIfNew(id) {
    if (seen.has(id)) return false;
    seen.add(id);
    seenOrder.push(id);
    if (seenOrder.length > MAX_SEEN) {
      var oldest = seenOrder.shift();
      seen.delete(oldest);
    }
    return true;
  }

  function playNext() {
    if (playing || queue.length === 0) return;
    var evt = queue.shift();
    playing = true;
    var src = evt.kind === 'tts'
      ? (window.location.pathname + '/tts/' + encodeURIComponent(evt.audioId))
      : evt.url;
    var audio = new Audio(src);
    audio.volume = Math.max(0, Math.min(100, Number(evt.volume) || 0)) / 100;
    var advance = function () {
      playing = false;
      playNext();
    };
    audio.addEventListener('ended', advance);
    audio.addEventListener('error', advance);
    audio.play().catch(advance);
  }

  // Built from location.pathname (this exact /overlay/:token URL, no trailing slash) rather than a literal
  // './stream' — a relative reference without a trailing slash on the base resolves against the PARENT of
  // the last path segment, which would silently drop the token and hit /overlay/stream instead.
  var source = new EventSource(window.location.pathname + '/stream');
  source.onmessage = function (event) {
    var data;
    try {
      data = JSON.parse(event.data);
    } catch (err) {
      return;
    }
    if (!data || typeof data.id !== 'string') return;
    if (data.kind !== 'sound' && data.kind !== 'tts') return;
    if (!markSeenIfNew(data.id)) return;
    queue.push(data);
    playNext();
  };
  source.onerror = function () {
    // No-op: EventSource reconnects automatically on its own after a network/server error.
  };
})();
</script>`);
}

/**
 * OBS browser-source overlay for channel-point reward alerts (channel-points spec v1, "Overlay transport").
 * Structure copied faithfully from `apps/api/src/routes/verify.ts`: inline HTML string, per-request CSP
 * nonce matching the inline `<script>`'s nonce, token-in-path as an unauthenticated capability, 410 when the
 * token doesn't resolve. Unlike verify.ts there's no app-wide-CSP-is-disabled precedent to lean on for the
 * transparent/no-UI page here either, so the same per-route CSP approach is reused, extended with
 * `connect-src`/`media-src` for the EventSource + `<audio>` this page actually uses.
 *
 * Token resolution and the SSE connection registry live in `../lib/overlay-token` and
 * `../lib/overlay-registry` respectively — `app.ts` wires a dedicated Redis subscriber that publishes into
 * the same registry this file's `/stream` route reads from (see the comment on that wiring for why it must
 * be a second ioredis client).
 */
export default async function overlayRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/:token',
    { schema: { params: tokenParamSchema }, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { token } = request.params;
      const channelId = await resolveOverlayChannelId(app.redis, app.prisma, token);

      const nonce = randomBytes(16).toString('base64');
      reply.header('Content-Security-Policy', cspHeader(nonce));
      reply.header('X-Frame-Options', 'DENY');
      reply.type('text/html; charset=utf-8');

      if (!channelId) {
        reply.status(410);
        return expiredPage();
      }

      return overlayPage(nonce);
    },
  );

  app.get(
    '/:token/stream',
    { schema: { params: tokenParamSchema }, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { token } = request.params;
      const channelId = await resolveOverlayChannelId(app.redis, app.prisma, token);
      if (!channelId) {
        reply.status(410);
        reply.type('text/plain; charset=utf-8');
        return 'This overlay link is no longer valid.';
      }

      // Bypass Fastify's normal reply lifecycle so the connection can stay open indefinitely and be written
      // to later, from the Redis-subscriber callback in app.ts, via the registry below.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        // Reverse proxies (Railway's included) buffer proxied responses by default, which would hold every
        // event in a buffer instead of streaming it to the browser as it's written. Standard opt-out header.
        'X-Accel-Buffering': 'no',
      });

      // Railway's proxy (and most others) drops a connection it hasn't seen traffic on for a while — a
      // periodic comment line is invisible to the page's `onmessage` handler (SSE comments start with `:`)
      // but counts as traffic, keeping the connection alive between real alerts.
      const pingTimer = setInterval(() => {
        res.write(': ping\n\n');
      }, PING_INTERVAL_MS);

      const cleanup = (): void => {
        clearInterval(pingTimer);
        unregisterOverlayConnection(channelId, res);
      };

      // Handlers are attached BEFORE registering the connection. A client that vanishes during setup fires
      // 'close' regardless, so registering first would leave a window where the connection is in the
      // registry (and the ping timer running) with nothing listening to tear it down — a slow leak of one
      // dead connection plus one timer per occurrence.
      request.raw.once('close', cleanup);
      request.raw.once('error', cleanup);

      registerOverlayConnection(channelId, res);
    },
  );

  app.get(
    '/:token/tts/:audioId',
    { schema: { params: ttsParamSchema }, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { token, audioId } = request.params;
      const channelId = await resolveOverlayChannelId(app.redis, app.prisma, token);
      if (!channelId) {
        reply.status(410);
        reply.type('text/plain; charset=utf-8');
        return 'This overlay link is no longer valid.';
      }

      const encoded = await app.redis.get(redisKey('overlay', 'tts', channelId, audioId));
      if (!encoded) {
        reply.status(404);
        reply.type('text/plain; charset=utf-8');
        return 'Not found.';
      }

      reply.header('Cache-Control', 'no-store');
      reply.type('audio/mpeg');
      return reply.send(Buffer.from(encoded, 'base64'));
    },
  );
}
