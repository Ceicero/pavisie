import type { PrismaStubOverrides } from '@pavisie/plugins/sdk/testing';
import { describe, expect, it } from 'vitest';
import { buildTestApp, loginAs, seedUserGuilds } from './helpers/build-test-app';

const GUILD_ID = '600000000000000001';
const USER_ID = '600000000000000002';
const OPENER_ID = '600000000000000003';

interface FakeTicket {
  id: string;
  guildId: string;
  number: number;
  openerId: string;
  channelId: string | null;
  threadId: string | null;
  mode: 'CHANNEL' | 'THREAD';
  status: 'OPEN' | 'CLOSED' | 'ARCHIVED';
  subject: string | null;
  intake: unknown;
  tags: string[];
  assigneeId: string | null;
  panelId: string | null;
  closedAt: Date | null;
  closedBy: string | null;
  closeReason: string | null;
  slaDueAt: Date | null;
  firstResponseAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakePanel {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  title: string;
  description: string;
  buttonLabel: string;
  categoryId: string | null;
  supportRoleIds: string[];
  mode: 'CHANNEL' | 'THREAD';
  intakeForm: unknown;
  slaMinutes: number | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** In-memory Ticket/TicketPanel/TicketTranscript/TicketParticipant store — enough for the tickets route round trips. */
function ticketsFixture() {
  const tickets = new Map<string, FakeTicket>();
  const panels = new Map<string, FakePanel>();
  const transcripts = new Map<
    string,
    { ticketId: string; htmlContent: string | null; jsonContent: unknown }
  >();
  const participants = new Map<
    string,
    { id: string; ticketId: string; userId: string; addedBy: string; createdAt: Date }[]
  >();
  let panelSeq = 0;

  function matchesTicketWhere(t: FakeTicket, where: Record<string, unknown> = {}): boolean {
    if (where.id !== undefined && t.id !== where.id) return false;
    if (where.guildId !== undefined && t.guildId !== where.guildId) return false;
    if (where.deletedAt === null && t.deletedAt !== null) return false;
    if (where.status !== undefined && t.status !== where.status) return false;
    if (where.assigneeId !== undefined && t.assigneeId !== where.assigneeId) return false;
    if (where.tags && typeof where.tags === 'object' && 'has' in (where.tags as object)) {
      const wanted = (where.tags as { has: string }).has;
      if (!t.tags.includes(wanted)) return false;
    }
    return true;
  }

  return {
    tickets,
    panels,
    transcripts,
    seedTicket(overrides: Partial<FakeTicket> & { id: string }): FakeTicket {
      const now = new Date();
      const ticket: FakeTicket = {
        guildId: GUILD_ID,
        number: tickets.size + 1,
        openerId: OPENER_ID,
        channelId: '700000000000000001',
        threadId: null,
        mode: 'CHANNEL',
        status: 'OPEN',
        subject: null,
        intake: null,
        tags: [],
        assigneeId: null,
        panelId: null,
        closedAt: null,
        closedBy: null,
        closeReason: null,
        slaDueAt: null,
        firstResponseAt: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      };
      tickets.set(ticket.id, ticket);
      return ticket;
    },
    overrides: {
      ticket: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake, args shape mirrors Prisma's generated types
        findFirst: async (args: any) => {
          const found = [...tickets.values()].find((t) => matchesTicketWhere(t, args.where));
          if (!found) return null;
          if (args.include?.participants) {
            return { ...found, participants: participants.get(found.id) ?? [] };
          }
          return found;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
        findMany: async (args: any) =>
          [...tickets.values()].filter((t) => matchesTicketWhere(t, args?.where)),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
        update: async (args: any) => {
          const existing = tickets.get(args.where.id);
          if (!existing) throw new Error('not found');
          const updated = { ...existing, ...args.data, updatedAt: new Date() } as FakeTicket;
          tickets.set(args.where.id, updated);
          return updated;
        },
      },
      ticketPanel: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
        findFirst: async (args: any) => {
          const where = args.where ?? {};
          return (
            [...panels.values()].find(
              (p) =>
                (where.id === undefined || p.id === where.id) &&
                (where.guildId === undefined || p.guildId === where.guildId) &&
                (where.deletedAt !== null || p.deletedAt === null),
            ) ?? null
          );
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
        findMany: async (args: any) => {
          const where = args.where ?? {};
          return [...panels.values()].filter(
            (p) =>
              (where.guildId === undefined || p.guildId === where.guildId) &&
              (where.deletedAt !== null || p.deletedAt === null),
          );
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
        create: async (args: any) => {
          panelSeq += 1;
          const now = new Date();
          const panel: FakePanel = {
            id: `panel_${panelSeq}`,
            messageId: null,
            categoryId: null,
            supportRoleIds: [],
            intakeForm: null,
            slaMinutes: null,
            deletedAt: null,
            createdAt: now,
            updatedAt: now,
            ...args.data,
          };
          panels.set(panel.id, panel);
          return panel;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
        update: async (args: any) => {
          const existing = panels.get(args.where.id);
          if (!existing) throw new Error('not found');
          const updated = { ...existing, ...args.data, updatedAt: new Date() } as FakePanel;
          panels.set(args.where.id, updated);
          return updated;
        },
      },
      ticketTranscript: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
        findUnique: async (args: any) => transcripts.get(args.where.ticketId) ?? null,
      },
      guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
    } satisfies PrismaStubOverrides,
  };
}

async function authedContext(fixture: ReturnType<typeof ticketsFixture>) {
  const { app, redis, queues } = await buildTestApp(fixture.overrides);
  const { cookieHeader, session } = await loginAs(app, redis, { userId: USER_ID });
  await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);
  const mutHeaders = {
    cookie: cookieHeader,
    origin: 'http://localhost:3000',
    'x-csrf-token': session.csrfToken,
  };
  return { app, queues, cookieHeader, mutHeaders };
}

describe('tickets panels', () => {
  it('creates a panel and returns it as a TicketPanelDto', async () => {
    const fixture = ticketsFixture();
    const { app, mutHeaders } = await authedContext(fixture);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/tickets/panels`,
      headers: mutHeaders,
      payload: {
        channelId: '700000000000000001',
        title: 'Support',
        description: 'Need help?',
        buttonLabel: 'Open a ticket',
        mode: 'CHANNEL',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      guildId: GUILD_ID,
      channelId: '700000000000000001',
      title: 'Support',
      mode: 'CHANNEL',
    });

    await app.close();
  });

  it('enqueues a tickets.postPanel bot-action job when posting a panel', async () => {
    const fixture = ticketsFixture();
    fixture.panels.set('panel_1', {
      id: 'panel_1',
      guildId: GUILD_ID,
      channelId: '700000000000000001',
      messageId: null,
      title: 'Support',
      description: 'Need help?',
      buttonLabel: 'Open a ticket',
      categoryId: null,
      supportRoleIds: [],
      mode: 'CHANNEL',
      intakeForm: null,
      slaMinutes: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { app, queues, mutHeaders } = await authedContext(fixture);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/tickets/panels/panel_1/post`,
      headers: mutHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, queued: true });
    expect(queues.calls).toContainEqual({
      queue: 'bot-actions',
      name: 'bot-action',
      data: {
        type: 'tickets.postPanel',
        guildId: GUILD_ID,
        payload: { panelId: 'panel_1' },
        requestedBy: USER_ID,
      },
    });

    await app.close();
  });

  it('404s posting a panel that does not exist', async () => {
    const fixture = ticketsFixture();
    const { app, mutHeaders } = await authedContext(fixture);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/tickets/panels/nope/post`,
      headers: mutHeaders,
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});

describe('tickets queue', () => {
  it('lists tickets and computes slaBreached for an overdue, unanswered ticket', async () => {
    const fixture = ticketsFixture();
    fixture.seedTicket({
      id: 't1',
      number: 1,
      slaDueAt: new Date(Date.now() - 60_000),
      firstResponseAt: null,
    });
    fixture.seedTicket({
      id: 't2',
      number: 2,
      slaDueAt: new Date(Date.now() + 60_000),
      firstResponseAt: null,
    });
    fixture.seedTicket({
      id: 't3',
      number: 3,
      slaDueAt: new Date(Date.now() - 60_000),
      firstResponseAt: new Date(),
    });
    const { app, cookieHeader } = await authedContext(fixture);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/tickets/queue`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const byNumber = Object.fromEntries(
      body.items.map((t: { number: number; slaBreached: boolean }) => [t.number, t.slaBreached]),
    );
    expect(byNumber).toEqual({ 1: true, 2: false, 3: false });

    await app.close();
  });

  it('filters by status', async () => {
    const fixture = ticketsFixture();
    fixture.seedTicket({ id: 't1', number: 1, status: 'OPEN' });
    fixture.seedTicket({ id: 't2', number: 2, status: 'CLOSED', closedAt: new Date() });
    const { app, cookieHeader } = await authedContext(fixture);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/tickets/queue?status=CLOSED`,
      headers: { cookie: cookieHeader },
    });
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].number).toBe(2);

    await app.close();
  });

  it('filters by assigneeId and tag', async () => {
    const fixture = ticketsFixture();
    fixture.seedTicket({ id: 't1', number: 1, assigneeId: OPENER_ID, tags: ['billing'] });
    fixture.seedTicket({ id: 't2', number: 2, assigneeId: null, tags: [] });
    const { app, cookieHeader } = await authedContext(fixture);

    const byAssignee = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/tickets/queue?assigneeId=${OPENER_ID}`,
      headers: { cookie: cookieHeader },
    });
    expect(byAssignee.json().items).toHaveLength(1);

    const byTag = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/tickets/queue?tag=billing`,
      headers: { cookie: cookieHeader },
    });
    expect(byTag.json().items).toHaveLength(1);

    await app.close();
  });
});

describe('ticket detail', () => {
  it('includes participants and hasTranscript', async () => {
    const fixture = ticketsFixture();
    fixture.seedTicket({ id: 't1', number: 1 });
    fixture.transcripts.set('t1', { ticketId: 't1', htmlContent: '<html></html>', jsonContent: {} });
    const { app, cookieHeader } = await authedContext(fixture);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/tickets/t1`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasTranscript).toBe(true);
    expect(body.participants).toEqual([]);

    await app.close();
  });

  it('404s for a ticket in a different guild', async () => {
    const fixture = ticketsFixture();
    fixture.seedTicket({ id: 't1', number: 1, guildId: 'other-guild' });
    const { app, cookieHeader } = await authedContext(fixture);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/tickets/t1`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});

describe('ticket close', () => {
  it('enqueues a tickets.close bot-action and does not itself flip the status', async () => {
    const fixture = ticketsFixture();
    fixture.seedTicket({ id: 't1', number: 1, status: 'OPEN' });
    const { app, queues, mutHeaders } = await authedContext(fixture);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/tickets/t1/close`,
      headers: mutHeaders,
      payload: { reason: 'Resolved' },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true, queued: true });
    expect(queues.calls).toContainEqual({
      queue: 'bot-actions',
      name: 'bot-action',
      data: {
        type: 'tickets.close',
        guildId: GUILD_ID,
        payload: { ticketId: 't1', closedBy: USER_ID, reason: 'Resolved' },
        requestedBy: USER_ID,
      },
    });
    expect(fixture.tickets.get('t1')?.status).toBe('OPEN'); // the close itself is owned by the plugin, not this route

    await app.close();
  });

  it('rejects closing an already-closed ticket', async () => {
    const fixture = ticketsFixture();
    fixture.seedTicket({ id: 't1', number: 1, status: 'CLOSED', closedAt: new Date() });
    const { app, mutHeaders } = await authedContext(fixture);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/tickets/t1/close`,
      headers: mutHeaders,
      payload: {},
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });
});

describe('ticket assign', () => {
  it('sets the assignee directly (no bot-action needed)', async () => {
    const fixture = ticketsFixture();
    fixture.seedTicket({ id: 't1', number: 1 });
    const { app, mutHeaders } = await authedContext(fixture);

    const res = await app.inject({
      method: 'POST',
      url: `/guilds/${GUILD_ID}/tickets/t1/assign`,
      headers: mutHeaders,
      payload: { assigneeId: OPENER_ID },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().assigneeId).toBe(OPENER_ID);
    expect(fixture.tickets.get('t1')?.assigneeId).toBe(OPENER_ID);

    await app.close();
  });
});

describe('ticket transcript download', () => {
  it('serves the HTML transcript with a sanitized Content-Disposition filename', async () => {
    const fixture = ticketsFixture();
    fixture.seedTicket({ id: 't1', number: 9 });
    fixture.transcripts.set('t1', {
      ticketId: 't1',
      htmlContent: '<html><body>hi</body></html>',
      jsonContent: { messages: [] },
    });
    const { app, cookieHeader } = await authedContext(fixture);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/tickets/t1/transcript`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="ticket-9-transcript.html"');
    expect(res.body).toContain('hi');

    await app.close();
  });

  it('serves the JSON transcript when format=json', async () => {
    const fixture = ticketsFixture();
    fixture.seedTicket({ id: 't1', number: 9 });
    fixture.transcripts.set('t1', {
      ticketId: 't1',
      htmlContent: '<html></html>',
      jsonContent: { messages: [{ content: 'hi' }] },
    });
    const { app, cookieHeader } = await authedContext(fixture);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/tickets/t1/transcript?format=json`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="ticket-9-transcript.json"');
    expect(JSON.parse(res.body)).toEqual({ messages: [{ content: 'hi' }] });

    await app.close();
  });

  it('404s when no transcript has been generated yet', async () => {
    const fixture = ticketsFixture();
    fixture.seedTicket({ id: 't1', number: 1 });
    const { app, cookieHeader } = await authedContext(fixture);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/tickets/t1/transcript`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});
