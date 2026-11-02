import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const settingsPage = readFileSync(
  fileURLToPath(new URL('../src/app/dashboard/[guildId]/settings/page.tsx', import.meta.url)),
  'utf8',
);

describe('Settings: "Powered by Pavisie" switch', () => {
  it('reads and writes the admin plugin config key the bot reads', () => {
    expect(settingsPage).toContain("usePluginConfig<AdminSettings>(guildId, 'admin')");
    expect(settingsPage).toContain("useUpdatePluginConfig<AdminSettings>(guildId, 'admin')");
    expect(settingsPage).toContain('{ poweredByFooter: next }');
  });

  it('treats a missing value as on, like the bot does', () => {
    expect(settingsPage).toContain('data?.config.poweredByFooter !== false');
  });
});
