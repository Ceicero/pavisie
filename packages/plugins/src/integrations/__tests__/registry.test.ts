import { describe, expect, it } from 'vitest';
import { INTEGRATION_PROVIDER_IDS } from '@pavisie/types/integrations';
import { PROVIDER_ENUM_MAP, getProvider, providerIdFromEnum } from '../providers';

// GitHub, Notion and Stripe (the guild-facing connector) were removed as offered providers on 2026-09-02
// (Brandon's decision, docs/ARCHITECTURE.md §18a); Instagram was added the same day. This test pins the
// registry's shape so a future change can't silently resurrect one of the removed three or drop Instagram.
describe('integrations provider registry', () => {
  it('no longer lists github, notion or stripe as connectable providers', () => {
    expect(INTEGRATION_PROVIDER_IDS).not.toContain('github');
    expect(INTEGRATION_PROVIDER_IDS).not.toContain('notion');
    expect(INTEGRATION_PROVIDER_IDS).not.toContain('stripe');

    expect(getProvider('github')).toBeUndefined();
    expect(getProvider('notion')).toBeUndefined();
    expect(getProvider('stripe')).toBeUndefined();
  });

  it('lists instagram as a connectable oauth provider', () => {
    expect(INTEGRATION_PROVIDER_IDS).toContain('instagram');

    const def = getProvider('instagram');
    expect(def).toBeDefined();
    expect(def?.kind).toBe('oauth');
    expect(def?.requiredEnv).toEqual(['INSTAGRAM_CLIENT_ID', 'INSTAGRAM_CLIENT_SECRET']);
    expect(typeof def?.poll).toBe('function');
  });

  it('maps instagram to the Prisma enum value both ways, and leaves the retired enum values unmapped', () => {
    expect(PROVIDER_ENUM_MAP.instagram).toBe('INSTAGRAM');
    expect(providerIdFromEnum('INSTAGRAM')).toBe('instagram');

    // GITHUB/NOTION/STRIPE remain valid Prisma enum values (for historical rows, schema.prisma) but this
    // plugin no longer owns or creates connections of them — same treatment as OPENAI/ANTHROPIC (the `ai`
    // plugin's connectors), which were already unmapped here before this change.
    expect(providerIdFromEnum('GITHUB')).toBeUndefined();
    expect(providerIdFromEnum('NOTION')).toBeUndefined();
    expect(providerIdFromEnum('STRIPE')).toBeUndefined();
  });
});
