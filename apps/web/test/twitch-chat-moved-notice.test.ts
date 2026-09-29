import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { TwitchChatGuildLinksDto } from '@pavisie/types/integrations';
import { integrationsQueryKeys } from '../src/lib/dashboard/integrations-queries';
import { TwitchChatMovedNotice } from '../src/components/dashboard/integrations/twitch-chat-moved-notice';

/**
 * Creator-dashboard phase 4 (docs/ARCHITECTURE.md section 19e): the Discord dashboard's Integrations page no longer
 * manages any Twitch chat feature. It shows this notice instead: where everything moved (the creator dashboard), and
 * — read-only — which Twitch channel is linked to the server, with the one action a server admin keeps (unlink).
 */

const GUILD = '123456789012345678';

function render(links: TwitchChatGuildLinksDto | undefined): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (links) client.setQueryData(integrationsQueryKeys.twitchChatLinks(GUILD), links);
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(TwitchChatMovedNotice, { guildId: GUILD })),
  );
}

describe('TwitchChatMovedNotice', () => {
  it('points at the creator dashboard and does not offer any Twitch chat management', () => {
    const html = render({ channels: [] });
    expect(html).toContain('Twitch chat, channel points and currency');
    expect(html).toContain('href="/creator"');
    expect(html).toContain('managed by the streamer on the creator dashboard');
    // Nothing to manage here any more: no connect button, no command/timer/reward tables, no unlink button.
    expect(html).not.toMatch(/Connect a Twitch channel/i);
    expect(html).not.toMatch(/Add reward|Add command|Add timer/i);
    expect(html).not.toContain('Linked to this server');
    expect(html).not.toContain('Unlink this server');
  });

  it('shows a linked channel read-only, with the streamer-managed note and an Unlink button', () => {
    const html = render({
      channels: [
        {
          id: 'chan-1',
          broadcasterLogin: 'coolstreamer',
          linkedByStreamer: true,
          linkedAt: '2026-09-29T00:00:00.000Z',
          enabled: true,
          status: 'connected',
        },
      ],
    });
    expect(html).toContain('Linked to this server');
    expect(html).toContain('coolstreamer');
    expect(html).toContain('The streamer manages this channel from their creator dashboard.');
    expect(html).toContain('Unlink this server');
    expect(html).toContain('chat bot on');
    // Read-only: no enable switch, prefix field or delete-style wording.
    expect(html).not.toMatch(/role="switch"/);
    expect(html).not.toMatch(/Command prefix/i);
    expect(html).not.toMatch(/Disconnect/);
  });

  it('says the chat bot is off (not hides it) for a linked channel the streamer switched off', () => {
    const html = render({
      channels: [
        {
          id: 'chan-1',
          broadcasterLogin: 'quietstreamer',
          linkedByStreamer: false,
          linkedAt: null,
          enabled: false,
          status: 'disconnected',
        },
      ],
    });
    expect(html).toContain('quietstreamer');
    expect(html).toContain('chat bot off');
  });
});
