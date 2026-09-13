import { PermissionError, RateLimitError, ValidationError } from '@pavisie/core';
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext, ComponentContext } from '../../sdk';
import { createTestContext } from '../../sdk/testing';
import { reportComponents } from '../components/report';
import { command as reportCommand } from '../commands/report';

const reportContinueHandler = reportComponents.find((h) => h.action === 'report-continue')!;
const reportModalHandler = reportComponents.find((h) => h.action === 'report-modal')!;

const ALLOWED_CREATE_KEYS = [
  'guildId',
  'guildName',
  'senderId',
  'senderTag',
  'kind',
  'subject',
  'body',
  'botVersion',
].sort();

function buildCommandContext(overrides: { staffLevel?: CommandContext['staffLevel'] } = {}): CommandContext {
  const interaction = {
    user: { id: 'admin-1' },
    options: {
      getSubcommand: () => 'report',
      getString: () => 'BUG',
    },
    reply: vi.fn(async () => undefined),
  };
  const { ctx } = createTestContext();
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake interaction, see sibling test files for the same pattern
    interaction: interaction as any,
    ctx,
    guildId: 'g1',
    staffLevel: overrides.staffLevel ?? 'admin',
    locale: 'en-US' as never,
    t: (key: string) => key,
    config: async <T>() => ({}) as T,
  };
}

interface BuildModalHarnessOptions {
  guildId?: string;
  userId?: string;
  kind?: string;
  subject?: string;
  body?: string;
  senderTag?: string;
  guildName?: string;
}

function buildModalHarness(opts: BuildModalHarnessOptions = {}) {
  const created: Record<string, unknown>[] = [];
  const auditCalls: Record<string, unknown>[] = [];

  const { ctx } = createTestContext({
    prismaOverrides: {
      developerReport: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        create: async (args: any) => {
          created.push(args.data);
          return { id: `dr-${created.length}`, createdAt: new Date(), status: 'OPEN', ...args.data };
        },
      },
    },
    overrides: {
      audit: async (entry) => {
        auditCalls.push(entry as unknown as Record<string, unknown>);
      },
    },
  });

  const fields: Record<string, string> = {
    subject: opts.subject ?? 'Something is broken',
    body: opts.body ?? 'Steps to reproduce: click the button, nothing happens.',
  };
  const reply = vi.fn(async () => undefined);
  const interaction = {
    user: { id: opts.userId ?? 'admin-1', tag: opts.senderTag ?? 'admin-1#0001' },
    guild: { name: opts.guildName ?? 'Test Guild' },
    fields: { getTextInputValue: (id: string) => fields[id] ?? '' },
    reply,
  };

  const c: ComponentContext = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    interaction: interaction as any,
    ctx,
    guildId: opts.guildId ?? 'g1',
    staffLevel: 'admin',
    locale: 'en-US' as never,
    t: (key: string) => key,
    config: async <T>() => ({}) as T,
    args: [opts.userId ?? 'admin-1', opts.kind ?? 'BUG'],
  };

  return { c, created, auditCalls, reply };
}

describe('/pavisie report command', () => {
  it('rejects non-admin staff levels', async () => {
    const c = buildCommandContext({ staffLevel: 'moderator' });
    await expect(reportCommand.execute(c)).rejects.toThrow(PermissionError);
  });

  it('replies with a disclosure embed and a "Write report" button for an admin', async () => {
    const c = buildCommandContext({ staffLevel: 'admin' });
    await reportCommand.execute(c);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reply = (c.interaction as any).reply as ReturnType<typeof vi.fn>;
    expect(reply).toHaveBeenCalledTimes(1);
    const payload = reply.mock.calls[0][0];
    expect(payload.ephemeral).toBe(true);
    expect(payload.components).toHaveLength(1);
  });
});

describe('report-continue button', () => {
  it('opens a modal carrying the owner id and kind, asking only for subject + body', async () => {
    const showModal = vi.fn(async (_modal: unknown) => undefined);
    const interaction = { showModal };
    const { ctx } = createTestContext();
    const c: ComponentContext = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      interaction: interaction as any,
      ctx,
      guildId: 'g1',
      staffLevel: 'admin',
      locale: 'en-US' as never,
      t: (key: string) => key,
      config: async <T>() => ({}) as T,
      args: ['admin-1', 'FEEDBACK'],
    };

    await reportContinueHandler.handler(c);

    expect(showModal).toHaveBeenCalledTimes(1);
    const modal = showModal.mock.calls[0][0] as { toJSON: () => { custom_id: string; components: unknown[] } };
    const json = modal.toJSON();
    expect(json.custom_id).toBe('admin:report-modal:admin-1:FEEDBACK');
    expect(json.components).toHaveLength(2); // subject + body only — no kind field, it's already known
  });
});

describe('report-modal submission', () => {
  it('persists only the typed fields plus unavoidable routing metadata (regression: nothing else is stored)', async () => {
    const { c, created, auditCalls, reply } = buildModalHarness({
      guildId: 'g1',
      userId: 'admin-1',
      senderTag: 'admin-1#0001',
      guildName: 'Test Guild',
      kind: 'BUG',
      subject: '  Something is broken  ',
      body: '  Steps to reproduce: click the button, nothing happens.  ',
    });

    await reportModalHandler.handler(c);

    expect(created).toHaveLength(1);
    const row = created[0];
    expect(Object.keys(row).sort()).toEqual(ALLOWED_CREATE_KEYS);
    expect(row).toMatchObject({
      guildId: 'g1',
      guildName: 'Test Guild',
      senderId: 'admin-1',
      senderTag: 'admin-1#0001',
      kind: 'BUG',
      subject: 'Something is broken',
      body: 'Steps to reproduce: click the button, nothing happens.',
    });
    expect(typeof row.botVersion).toBe('string');

    // Transparency in both directions: a guild audit entry is written for the submission.
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      guildId: 'g1',
      actorId: 'admin-1',
      actorType: 'user',
      action: 'developer_report.submit',
      targetType: 'developer_report',
      source: 'bot',
    });

    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown/tampered kind without touching the database', async () => {
    const { c, created } = buildModalHarness({ kind: 'NOT_A_REAL_KIND' });
    await expect(reportModalHandler.handler(c)).rejects.toThrow(ValidationError);
    expect(created).toHaveLength(0);
  });

  it('rejects an empty body without touching the database', async () => {
    const { c, created } = buildModalHarness({ body: '   ' });
    await expect(reportModalHandler.handler(c)).rejects.toThrow(ValidationError);
    expect(created).toHaveLength(0);
  });

  it('rejects an oversized subject without touching the database', async () => {
    const { c, created } = buildModalHarness({ subject: 'x'.repeat(500) });
    await expect(reportModalHandler.handler(c)).rejects.toThrow(ValidationError);
    expect(created).toHaveLength(0);
  });

  it('blocks a single admin flooding past their own per-user limit', async () => {
    const { ctx } = createTestContext({
      prismaOverrides: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        developerReport: { create: async (args: any) => ({ id: 'x', ...args.data }) },
      },
    });
    const fields: Record<string, string> = { subject: 'Bug', body: 'Details here.' };
    function makeContext(): ComponentContext {
      const interaction = {
        user: { id: 'admin-1', tag: 'admin-1#0001' },
        guild: { name: 'Test Guild' },
        fields: { getTextInputValue: (id: string) => fields[id] ?? '' },
        reply: vi.fn(async () => undefined),
      };
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        interaction: interaction as any,
        ctx,
        guildId: 'g1',
        staffLevel: 'admin',
        locale: 'en-US' as never,
        t: (key: string) => key,
        config: async <T>() => ({}) as T,
        args: ['admin-1', 'BUG'],
      };
    }

    // The per-user limit is 2 per window — the first two submissions succeed.
    await reportModalHandler.handler(makeContext());
    await reportModalHandler.handler(makeContext());
    // The third, from the same admin in the same guild, must be blocked.
    await expect(reportModalHandler.handler(makeContext())).rejects.toThrow(RateLimitError);
  });

  it('blocks an entire guild flooding past its collective limit, even across different admins', async () => {
    const { ctx } = createTestContext({
      prismaOverrides: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        developerReport: { create: async (args: any) => ({ id: 'x', ...args.data }) },
      },
    });
    const fields: Record<string, string> = { subject: 'Bug', body: 'Details here.' };
    function makeContext(userId: string): ComponentContext {
      const interaction = {
        user: { id: userId, tag: `${userId}#0001` },
        guild: { name: 'Test Guild' },
        fields: { getTextInputValue: (id: string) => fields[id] ?? '' },
        reply: vi.fn(async () => undefined),
      };
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        interaction: interaction as any,
        ctx,
        guildId: 'g1',
        staffLevel: 'admin',
        locale: 'en-US' as never,
        t: (key: string) => key,
        config: async <T>() => ({}) as T,
        args: [userId, 'BUG'],
      };
    }

    // The guild-wide limit is 5 per window, across five distinct admins (each under their own per-user limit).
    for (let i = 0; i < 5; i++) {
      await reportModalHandler.handler(makeContext(`admin-${i}`));
    }
    // A sixth admin, still comfortably under their own per-user limit, is blocked by the guild ceiling.
    await expect(reportModalHandler.handler(makeContext('admin-99'))).rejects.toThrow(RateLimitError);
  });
});
