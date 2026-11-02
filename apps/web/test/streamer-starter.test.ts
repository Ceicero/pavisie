import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isStarterFormValid, plainDiscordText } from '../src/lib/dashboard/starter-format';

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8');
}

describe('plainDiscordText', () => {
  it('drops Discord markdown and turns channel mentions into a readable label', () => {
    expect(
      plainDiscordText('Watching **shroud**: a go-live alert will be posted in <#123456789012345678>.'),
    ).toBe('Watching shroud: a go-live alert will be posted in #channel.');
    expect(plainDiscordText('`/statschannel list|create|remove`, or Dashboard → Community.')).toBe(
      '/statschannel list|create|remove, or Dashboard → Community.',
    );
  });

  it('leaves plain text alone', () => {
    expect(plainDiscordText('Leveling was already on.')).toBe('Leveling was already on.');
  });
});

describe('isStarterFormValid', () => {
  it('needs a channel only when a Twitch login was typed', () => {
    expect(isStarterFormValid('', null)).toBe(true);
    expect(isStarterFormValid('   ', null)).toBe(true);
    expect(isStarterFormValid('shroud', null)).toBe(false);
    expect(isStarterFormValid('shroud', '123456789012345678')).toBe(true);
  });
});

describe('streamer starter wiring', () => {
  it('is offered on the guild overview page', () => {
    expect(source('app/dashboard/[guildId]/page.tsx')).toContain('<StreamerStarterCard guildId={guildId} />');
  });

  it('talks to the endpoints the API exposes', () => {
    const queries = source('lib/dashboard/setup-queries.ts');
    expect(queries).toContain('/guilds/${guildId}/setup/streamer-starter');
    expect(queries).toContain('/guilds/${guildId}/setup/streamer-starter/${requestId}');
  });
});
