import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { Switch } from '@pavisie/ui';
import { API_BASE_URL, ApiClientError, setCsrfToken } from '../src/lib/dashboard/api';
import {
  inboundRequireTimestampMutationOptions,
  integrationsQueryKeys,
} from '../src/lib/dashboard/integrations-queries';
import type { WebhookEndpointDetailDto } from '@pavisie/types/integrations';
import {
  REQUIRE_TIMESTAMP_HELP,
  applyRequireTimestamp,
  patchInboundWebhookRequireTimestamp,
  readRequireTimestamp,
  requireTimestampErrorMessage,
} from '../src/lib/dashboard/webhook-require-timestamp';
import {
  RequireTimestampField,
  RequireTimestampSwitch,
} from '../src/components/dashboard/integrations/require-timestamp-setting';

const HELP =
  'When on, each delivery must include X-Pavisie-Timestamp (Unix seconds), and X-Pavisie-Signature must be the hex HMAC-SHA256 of the timestamp, a full stop, then the raw body, using the endpoint secret. Deliveries more than 5 minutes off, or missing the header, are rejected with 401.';

function endpoint(overrides: Partial<WebhookEndpointDetailDto> & { id: string }): WebhookEndpointDetailDto {
  return {
    guildId: 'g1',
    provider: 'generic',
    direction: 'inbound',
    url: null,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    name: overrides.id,
    events: [],
    channelId: null,
    failureCount: 0,
    lastDeliveryAt: null,
    requireTimestamp: false,
    ...overrides,
  };
}

function isReactElement(node: unknown): node is ReactElement {
  return typeof node === 'object' && node !== null && Object.prototype.hasOwnProperty.call(node, '$$typeof');
}

/** Invokes our hookless function components so the test can see the elements they return. */
function walk(node: unknown, visit: (el: ReactElement) => void) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node === 'string' || typeof node === 'number') return;
  if (!isReactElement(node)) return;
  if (typeof node.type === 'function') {
    walk((node.type as (props: unknown) => unknown)(node.props), visit);
    return;
  }
  visit(node);
  walk((node.props as { children?: unknown }).children, visit);
}

function textOf(node: unknown): string {
  const parts: string[] = [];
  const collect = (current: unknown) => {
    if (Array.isArray(current)) {
      for (const child of current) collect(child);
      return;
    }
    if (typeof current === 'string' || typeof current === 'number') {
      parts.push(String(current));
      return;
    }
    if (!isReactElement(current)) return;
    if (typeof current.type === 'function') {
      collect((current.type as (props: unknown) => unknown)(current.props));
      return;
    }
    collect((current.props as { children?: unknown }).children);
  };
  collect(node);
  return parts.join('');
}

function switchesIn(node: unknown): ReactElement[] {
  const found: ReactElement[] = [];
  walk(node, (el) => {
    if (el.type === Switch) found.push(el);
  });
  return found;
}

describe('readRequireTimestamp', () => {
  it('treats a missing value as off', () => {
    expect(readRequireTimestamp(undefined)).toBe(false);
    expect(readRequireTimestamp(null)).toBe(false);
    expect(readRequireTimestamp({})).toBe(false);
    expect(readRequireTimestamp({ requireTimestamp: undefined })).toBe(false);
    expect(readRequireTimestamp(endpoint({ id: 'a' }))).toBe(false);
  });

  it('is on only when the field is exactly true', () => {
    expect(readRequireTimestamp({ requireTimestamp: false })).toBe(false);
    expect(readRequireTimestamp({ requireTimestamp: true })).toBe(true);
  });
});

describe('require timestamp help text', () => {
  it('is the delivery contract, verbatim', () => {
    expect(REQUIRE_TIMESTAMP_HELP).toBe(HELP);
  });
});

describe('requireTimestampErrorMessage', () => {
  it('maps each webhook error code to friendly copy and hides the raw code', () => {
    const cases: [string, string][] = [
      ['validation_error', 'That change was rejected. Refresh the page and try the toggle again.'],
      ['unauthenticated', "You're signed out. Sign in again, then try the toggle."],
      ['permission_denied', "You don't have permission to change this webhook."],
      ['not_found', 'This webhook no longer exists. Refresh the page to see the current list.'],
      ['rate_limited', 'Too many changes at once. Wait a moment, then try the toggle again.'],
    ];
    for (const [code, message] of cases) {
      const err = new ApiClientError('raw', { code, status: 400 });
      const friendly = requireTimestampErrorMessage(err);
      expect(friendly).toBe(message);
      expect(friendly).not.toContain(code);
    }
  });

  it('falls back to the server message for an unknown code, and a generic line otherwise', () => {
    expect(
      requireTimestampErrorMessage(
        new ApiClientError('Could not reach the Pavisie API.', { code: 'network_error', status: 0 }),
      ),
    ).toBe('Could not reach the Pavisie API.');
    expect(requireTimestampErrorMessage(new Error('nope'))).toBe('Please try again.');
  });
});

describe('applyRequireTimestamp', () => {
  it('updates only the targeted row', () => {
    const next = applyRequireTimestamp(
      [endpoint({ id: 'a' }), endpoint({ id: 'b', requireTimestamp: true })],
      'a',
      true,
    );
    expect(next?.map((hook) => readRequireTimestamp(hook))).toEqual([true, true]);
    expect(next?.[0]?.name).toBe('a');
  });

  it('leaves an undefined list undefined', () => {
    expect(applyRequireTimestamp(undefined, 'a', true)).toBeUndefined();
  });
});

describe('inbound require-timestamp mutation', () => {
  function clientWith(rows: WebhookEndpointDetailDto[]) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(integrationsQueryKeys.inboundWebhooks('g1'), rows);
    return queryClient;
  }

  it('flips the row immediately and reverts only that row when the save fails', async () => {
    const queryClient = clientWith([endpoint({ id: 'a' }), endpoint({ id: 'b', requireTimestamp: true })]);
    const options = inboundRequireTimestampMutationOptions('g1', queryClient);

    const context = await options.onMutate({ endpointId: 'a', requireTimestamp: true });
    const during = queryClient.getQueryData<WebhookEndpointDetailDto[]>(
      integrationsQueryKeys.inboundWebhooks('g1'),
    );
    expect(during?.map((hook) => readRequireTimestamp(hook))).toEqual([true, true]);

    options.onError(
      new ApiClientError('no', { code: 'permission_denied', status: 403 }),
      { endpointId: 'a', requireTimestamp: true },
      context,
    );
    const after = queryClient.getQueryData<WebhookEndpointDetailDto[]>(
      integrationsQueryKeys.inboundWebhooks('g1'),
    );
    expect(after?.map((hook) => readRequireTimestamp(hook))).toEqual([false, true]);
  });

  it('keeps a row that was already on when turning it off fails', async () => {
    const queryClient = clientWith([endpoint({ id: 'a', requireTimestamp: true })]);
    const options = inboundRequireTimestampMutationOptions('g1', queryClient);
    const context = await options.onMutate({ endpointId: 'a', requireTimestamp: false });
    options.onError(new Error('nope'), { endpointId: 'a', requireTimestamp: false }, context);
    const after = queryClient.getQueryData<WebhookEndpointDetailDto[]>(
      integrationsQueryKeys.inboundWebhooks('g1'),
    );
    expect(readRequireTimestamp(after?.[0])).toBe(true);
  });

  it('applies the 200 body, treating a missing requireTimestamp as off', async () => {
    const queryClient = clientWith([endpoint({ id: 'a' }), endpoint({ id: 'b' })]);
    const options = inboundRequireTimestampMutationOptions('g1', queryClient);
    await options.onMutate({ endpointId: 'a', requireTimestamp: true });

    options.onSuccess(
      endpoint({ id: 'a', name: 'Renamed', requireTimestamp: true }),
      { endpointId: 'a', requireTimestamp: true },
      undefined,
    );
    let rows = queryClient.getQueryData<WebhookEndpointDetailDto[]>(integrationsQueryKeys.inboundWebhooks('g1'));
    expect(rows?.[0]?.name).toBe('Renamed');
    expect(readRequireTimestamp(rows?.[0])).toBe(true);
    expect(readRequireTimestamp(rows?.[1])).toBe(false);

    const omitted = endpoint({ id: 'a', name: 'Renamed' });
    delete (omitted as { requireTimestamp?: boolean }).requireTimestamp;
    options.onSuccess(omitted, { endpointId: 'a', requireTimestamp: true }, undefined);
    rows = queryClient.getQueryData<WebhookEndpointDetailDto[]>(integrationsQueryKeys.inboundWebhooks('g1'));
    expect(readRequireTimestamp(rows?.[0])).toBe(false);
  });
});

describe('patchInboundWebhookRequireTimestamp', () => {
  let calls: { url: string; init: RequestInit }[];

  afterEach(() => {
    vi.unstubAllGlobals();
    setCsrfToken(null);
  });

  function stubFetch(status: number, body: unknown) {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  }

  it('PATCHes only requireTimestamp, with the session cookie and CSRF token', async () => {
    setCsrfToken('dashboard-csrf');
    stubFetch(200, endpoint({ id: 'ep1', requireTimestamp: true }));

    const saved = await patchInboundWebhookRequireTimestamp('guild 1', 'ep/1', true);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${API_BASE_URL}/guilds/guild 1/integrations/webhooks/ep/1`);
    expect(calls[0]?.init.method).toBe('PATCH');
    expect(calls[0]?.init.credentials).toBe('include');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ requireTimestamp: true });
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('X-CSRF-Token')).toBe('dashboard-csrf');
    expect(headers.get('Content-Type')).toBe('application/json');
    // Origin is a forbidden header; the browser attaches the dashboard page's Origin. Don't set it here.
    expect(headers.has('Origin')).toBe(false);
    expect(readRequireTimestamp(saved)).toBe(true);
  });

  it('can turn the setting off', async () => {
    setCsrfToken('dashboard-csrf');
    stubFetch(200, endpoint({ id: 'ep1', requireTimestamp: false }));
    await patchInboundWebhookRequireTimestamp('g1', 'ep1', false);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ requireTimestamp: false });
  });

  it('surfaces validation, auth, permission, not-found, and rate-limit errors', async () => {
    const statuses: [number, string][] = [
      [400, 'validation_error'],
      [401, 'unauthenticated'],
      [403, 'permission_denied'],
      [404, 'not_found'],
      [429, 'rate_limited'],
    ];
    for (const [status, code] of statuses) {
      setCsrfToken('dashboard-csrf');
      stubFetch(status, { error: { code, message: 'raw server message' } });
      await expect(patchInboundWebhookRequireTimestamp('g1', 'ep1', true)).rejects.toMatchObject({
        code,
        status,
        message: 'raw server message',
      });
    }
  });
});

describe('Require timestamp control', () => {
  it('shows the exact help text and a switch that reports the next value', () => {
    const onCheckedChange = vi.fn();
    const tree = RequireTimestampField({
      checked: false,
      helpId: 'create-help',
      onCheckedChange,
    });

    expect(textOf(tree)).toContain('Require timestamp');
    expect(textOf(tree)).toContain(HELP);

    const [toggle] = switchesIn(tree);
    expect(toggle).toBeDefined();
    const props = toggle!.props as {
      checked: boolean;
      disabled?: boolean;
      'aria-busy'?: boolean;
      'aria-describedby'?: string;
      onCheckedChange: (next: boolean) => void;
    };
    expect(props.checked).toBe(false);
    expect(props.disabled).toBe(false);
    expect(props['aria-busy']).toBeUndefined();
    expect(props['aria-describedby']).toBe('create-help');
    props.onCheckedChange(true);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(textOf(tree)).not.toContain('Saving…');
  });

  it('shows a pending state and ignores further toggles while a save is in flight', () => {
    const tree = RequireTimestampSwitch({
      checked: true,
      pending: true,
      helpId: 'list-help',
      label: 'Require timestamp for Releases',
      onCheckedChange: vi.fn(),
    });
    const [toggle] = switchesIn(tree);
    const props = toggle!.props as {
      checked: boolean;
      disabled?: boolean;
      'aria-busy'?: boolean;
      'aria-label'?: string;
    };
    expect(props.checked).toBe(true);
    expect(props.disabled).toBe(true);
    expect(props['aria-busy']).toBe(true);
    expect(props['aria-label']).toBe('Require timestamp for Releases');
    expect(textOf(tree)).toContain('Saving…');
  });
});

describe('incoming webhook screens', () => {
  const list = readFileSync(
    new URL('../src/components/dashboard/integrations/inbound-webhooks-list.tsx', import.meta.url),
    'utf8',
  );
  const dialog = readFileSync(
    new URL('../src/components/dashboard/integrations/inbound-webhook-dialog.tsx', import.meta.url),
    'utf8',
  );
  const outboundList = readFileSync(
    new URL('../src/components/dashboard/integrations/outbound-webhooks-list.tsx', import.meta.url),
    'utf8',
  );
  const outboundDialog = readFileSync(
    new URL('../src/components/dashboard/integrations/outbound-webhook-dialog.tsx', import.meta.url),
    'utf8',
  );

  it('puts the toggle on the incoming list and reads a missing flag as off', () => {
    expect(list).toContain('RequireTimestampSwitch');
    expect(list).toContain('RequireTimestampHelp');
    expect(list).toContain('checked={readRequireTimestamp(hook)}');
    expect(list).toContain('pending={savingTimestamp}');
    expect(list).toContain('requireTimestampErrorMessage');
    expect(list).toContain('Require timestamp');
  });

  it('sends the create form value and does not read the flag back from the 201 body', () => {
    expect(dialog).toContain('RequireTimestampField');
    expect(dialog).toContain('requireTimestamp,');
    expect(dialog).not.toContain('result.requireTimestamp');
  });

  it('does not offer the toggle for outbound webhooks', () => {
    for (const source of [outboundList, outboundDialog]) {
      expect(source).not.toContain('Require timestamp');
      expect(source).not.toContain('requireTimestamp');
      expect(source).not.toContain('RequireTimestamp');
    }
  });
});
