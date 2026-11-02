import { describe, expect, it } from 'vitest';
import { GatewayIntentBits } from 'discord.js';
import { statsRenameRateLimitFilter } from '@pavisie/plugins';
import { createClient } from '../src/client';

describe('createClient', () => {
  it('rejects instead of queueing only for stats-channel renames', () => {
    const client = createClient([GatewayIntentBits.Guilds]);
    // A function filter, not `true`/a route list: every other request must keep discord.js's normal queueing.
    expect(client.rest.options.rejectOnRateLimit).toBe(statsRenameRateLimitFilter);
    void client.destroy();
  });
});
