/**
 * `req` log serializer for the API (replaces Fastify's default, which logs the full `request.url`).
 *
 * The full URL would put two kinds of secret into every "incoming request" line:
 * - capability tokens that are path segments (`/overlay/:token…`, `/verify/:token`), and
 * - query strings, which carry the OAuth `code` and `state` on the `/auth/*` and `/integrations/*` callbacks.
 *
 * So the logged `url` is the path only, with secret segments masked, and `route` is the matched route pattern
 * (e.g. `/guilds/:guildId/moderation/cases`), which is what you usually want to group or search by anyway.
 * Ordinary ids (guild, case, rule…) stay in `url` so a single request can still be traced.
 */
const CENSOR = '[REDACTED]';

/** Route parameters whose value is a secret. Today only `:token` exists; the others are here so a new one is covered. */
const SECRET_PARAM = /token|secret|password|api[-_]?key/i;

/**
 * Path prefixes whose next segment is a capability token. Used when no route matched (a 404 such as
 * `/overlay/<real token>/typo`), where there are no parsed params to go by.
 */
const CAPABILITY_PREFIXES = ['/overlay/', '/verify/'];

/** The fields of a Fastify request this serializer reads; a structural type so it is easy to test. */
export interface LoggableRequest {
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
  params?: unknown;
  routeOptions?: { url?: string };
}

function maskSegment(path: string, value: string): string | undefined {
  for (const candidate of new Set([value, encodeURIComponent(value)])) {
    const at = path.indexOf(`/${candidate}`);
    if (candidate.length > 0 && at !== -1) {
      return `${path.slice(0, at + 1)}${CENSOR}${path.slice(at + 1 + candidate.length)}`;
    }
  }
  return undefined;
}

/** The request path with no query string and with secret segments masked. */
export function loggablePath(req: LoggableRequest): string {
  let path = (req.url ?? '').split('?', 1)[0] ?? '';
  const route = req.routeOptions?.url;
  if (route === undefined) {
    for (const prefix of CAPABILITY_PREFIXES) {
      if (path.startsWith(prefix)) {
        const rest = path.slice(prefix.length);
        const end = rest.indexOf('/');
        path = `${prefix}${CENSOR}${end === -1 ? '' : rest.slice(end)}`;
      }
    }
    return path;
  }
  const params = req.params && typeof req.params === 'object' ? (req.params as Record<string, unknown>) : {};
  for (const [name, value] of Object.entries(params)) {
    if (!SECRET_PARAM.test(name) || typeof value !== 'string' || value === '') continue;
    // If the value can't be located in the raw path (unusual encoding), log the pattern rather than risk the token.
    const masked = maskSegment(path, value);
    if (masked === undefined) return route;
    path = masked;
  }
  return path;
}

/** Same shape as Fastify's default `req` serializer, plus `route`, with `url` made safe to log. */
export function serializeRequest(req: LoggableRequest): Record<string, unknown> {
  return {
    method: req.method,
    url: loggablePath(req),
    route: req.routeOptions?.url,
    version: req.headers?.['accept-version'],
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}
