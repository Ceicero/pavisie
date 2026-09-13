import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { Button } from '@pavisie/ui';
import type { IntegrationConnectionDetailDto, IntegrationProviderInfoDto } from '@pavisie/types/integrations';
import { groupConnectionsByProvider } from '../src/lib/dashboard/integrations-queries';
import { ProviderCard } from '../src/components/dashboard/integrations/provider-card';

function connection(id: string, overrides: Partial<IntegrationConnectionDetailDto> = {}): IntegrationConnectionDetailDto {
  return {
    id,
    guildId: 'guild-1',
    provider: 'TWITCH',
    status: 'connected',
    externalAccountId: null,
    externalAccountName: null,
    scopes: [],
    connectedByUserId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    label: null,
    target: null,
    channelId: null,
    roleId: null,
    template: null,
    lastSyncAt: null,
    lastError: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------------------
// `groupConnectionsByProvider` — the exact spot the multi-account dedupe bug lived: the old
// `connectionByProvider` in page.tsx did `if (!map.has(...)) map.set(...)`, silently keeping only the first
// connection per provider. A guild with 3 Twitch accounts saw 1.
// ---------------------------------------------------------------------------------------------------------

describe('groupConnectionsByProvider', () => {
  it('keeps every connection for a provider, not just the first — regression for the dedupe bug', () => {
    const connections = [connection('conn-a'), connection('conn-b'), connection('conn-c')];

    const grouped = groupConnectionsByProvider(connections);

    expect(grouped.get('twitch')).toHaveLength(3);
    expect(grouped.get('twitch')?.map((c) => c.id)).toEqual(['conn-a', 'conn-b', 'conn-c']);
  });

  it('keeps each provider in its own bucket', () => {
    const connections = [
      connection('twitch-1', { provider: 'TWITCH' }),
      connection('github-1', { provider: 'GITHUB' }),
      connection('twitch-2', { provider: 'TWITCH' }),
    ];

    const grouped = groupConnectionsByProvider(connections);

    expect(grouped.get('twitch')?.map((c) => c.id)).toEqual(['twitch-1', 'twitch-2']);
    expect(grouped.get('github')?.map((c) => c.id)).toEqual(['github-1']);
  });

  it('has no entry at all for a provider with zero connections', () => {
    expect(groupConnectionsByProvider([]).get('twitch')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------
// `ProviderCard` — a plain, hookless function component, so calling it directly (rather than mounting it;
// this app's test setup has no jsdom/React Testing Library, see test/dashboard-nav.test.ts) returns the exact
// React element tree it renders, which this walks for the rows/buttons it actually produced.
// ---------------------------------------------------------------------------------------------------------

function isReactElement(node: unknown): node is ReactElement {
  return typeof node === 'object' && node !== null && Object.prototype.hasOwnProperty.call(node, '$$typeof');
}

function collect(
  node: unknown,
  matches: (el: ReactElement) => boolean,
  out: ReactElement[] = [],
): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, matches, out);
    return out;
  }
  if (!isReactElement(node)) return out;
  if (matches(node)) out.push(node);
  const children = (node.props as { children?: unknown }).children;
  if (children !== undefined) collect(children, matches, out);
  return out;
}

const PROVIDER: IntegrationProviderInfoDto = {
  id: 'twitch',
  name: 'Twitch',
  kind: 'oauth',
  available: true,
  missingEnv: [],
  supportsAlerts: true,
};

function disconnectButtonsOf(tree: ReactElement): ReactElement[] {
  return collect(tree, (el) => el.type === Button && (el.props as { variant?: string }).variant === 'ghost');
}

describe('ProviderCard', () => {
  it('renders one row per connection and wires each Disconnect button to its own connection id', () => {
    const connections = [connection('conn-a'), connection('conn-b'), connection('conn-c')];
    const onDisconnect = vi.fn();

    const tree = ProviderCard({ provider: PROVIDER, connections, onConnect: () => {}, onDisconnect });

    const disconnectButtons = disconnectButtonsOf(tree);
    expect(disconnectButtons).toHaveLength(3);

    disconnectButtons.forEach((button, index) => {
      (button.props as { onClick: () => void }).onClick();
      expect(onDisconnect).toHaveBeenNthCalledWith(index + 1, connections[index]!.id);
    });
    expect(onDisconnect).toHaveBeenCalledTimes(3);
  });

  it('renders no Disconnect row at all for zero connections — the pre-existing look', () => {
    const tree = ProviderCard({ provider: PROVIDER, connections: [], onConnect: () => {}, onDisconnect: vi.fn() });

    expect(disconnectButtonsOf(tree)).toHaveLength(0);
  });

  it('labels the Connect button "Connect another account" once at least one connection exists', () => {
    const withOne = ProviderCard({
      provider: PROVIDER,
      connections: [connection('conn-a')],
      onConnect: () => {},
      onDisconnect: vi.fn(),
    });
    const withNone = ProviderCard({ provider: PROVIDER, connections: [], onConnect: () => {}, onDisconnect: vi.fn() });

    // Filtered on label, not just `variant: 'outline'` + position — the "Add watch" button (rendered when
    // `provider.supportsAlerts`, as it is here) shares that same variant, so matching by position alone would
    // be fragile against reordering the card's sections.
    const connectButton = (tree: ReactElement) =>
      collect(
        tree,
        (el) =>
          el.type === Button &&
          (el.props as { variant?: string }).variant === 'outline' &&
          typeof (el.props as { children?: unknown }).children === 'string' &&
          ((el.props as { children: string }).children === 'Connect' ||
            (el.props as { children: string }).children === 'Connect another account'),
      )[0];

    expect((connectButton(withOne)?.props as { children?: string } | undefined)?.children).toBe(
      'Connect another account',
    );
    expect((connectButton(withNone)?.props as { children?: string } | undefined)?.children).toBe('Connect');
  });
});
