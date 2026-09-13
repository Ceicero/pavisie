// Cross-plugin `roles` service (ARCHITECTURE.md §7.5) plus the shared helpers commands/events/jobs use to send
// welcome/goodbye messages and post panels. Business logic only — discord.js/Prisma objects are fetched here,
// but the decisions (is this role safe to assign? what should the message say?) come from engine.ts.
import type { Guild, GuildMember, Role, TextBasedChannel } from 'discord.js';
import { AppError, NotFoundError, truncate } from '@pavisie/core';
import type {
  RolesService,
  VerificationDecisionInput as SdkVerificationDecisionInput,
} from '../sdk/services';
import { errorEmbed, resolveTextChannel, safeDm, successEmbed, type PluginContext } from '../sdk';
import {
  checkRoleAssignable,
  normalizeStoredEmbed,
  parseOnboardingProgress,
  renderTemplate,
  renderTemplateDeep,
  selectAutoRoles,
  type RoleAssignabilityReason,
  type TemplateVars,
} from './engine';
import {
  buildPanelMessagePayload,
  panelEmojiKey,
  reactionRoleMap,
  type PanelWithOptions,
} from './panel-render';
import type { RolesConfig, WelcomeGoodbyeConfig } from './manifest';

async function getRolesConfig(ctx: PluginContext, guildId: string): Promise<RolesConfig> {
  return ctx.getConfig<RolesConfig>(guildId);
}

function templateVarsFor(
  member: { id: string; user: { tag?: string; username: string } },
  guild: Guild,
): TemplateVars {
  const tag = member.user.tag ?? member.user.username;
  return {
    user: tag,
    'user.tag': tag,
    'user.id': member.id,
    server: guild.name,
    memberCount: guild.memberCount,
    mention: `<@${member.id}>`,
  };
}

/** Applies `checkRoleAssignable` to `roleIds`, returning the ones actually safe to grant plus a per-role skip reason for the rest. */
export function filterAssignableRoles(
  guild: Guild,
  roleIds: string[],
  allowElevatedRoles: boolean,
): { allowed: string[]; skipped: { roleId: string; reason: string }[] } {
  const botTopRolePosition = guild.members.me?.roles.highest.position ?? 0;
  const allowed: string[] = [];
  const skipped: { roleId: string; reason: string }[] = [];

  for (const roleId of roleIds) {
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      skipped.push({ roleId, reason: 'Role no longer exists.' });
      continue;
    }
    const result = checkRoleAssignable({
      permissionsBitfield: role.permissions.bitfield,
      position: role.position,
      managed: role.managed,
      botTopRolePosition,
      allowElevatedRoles,
    });
    if (result.ok) {
      allowed.push(roleId);
    } else {
      skipped.push({ roleId, reason: assignabilityMessage(result.reason) });
    }
  }

  return { allowed, skipped };
}

function assignabilityMessage(reason: 'elevated' | 'managed' | 'hierarchy'): string {
  if (reason === 'elevated')
    return 'This role grants an elevated permission and elevated roles are not allowed here.';
  if (reason === 'managed')
    return 'This role is managed by an integration/bot and cannot be assigned manually.';
  return "This role is at or above the bot's own highest role, so the bot can't assign it.";
}

// ---------------------------------------------------------------------------
// Auto-roles on join
// ---------------------------------------------------------------------------

export const AUTO_ROLE_JOB_NAME = 'autorole-apply';
export const AUTO_ROLE_AUDIT_ACTION = 'roles.autorole.apply';

export interface AutoRoleJobData {
  guildId: string;
  userId: string;
  roleIds: string[];
}

/** Deterministic job id so a member who leaves and rejoins inside the delay window only ever has ONE pending
 * auto-role job. Dash-separated: `:` is avoided in this codebase's custom BullMQ job ids (see
 * `birthdayRoleRemoveJobId` in `community/birthdays.ts` for why). */
export function autoRoleJobId(guildId: string, userId: string): string {
  return `autorole-${guildId}-${userId}`;
}

export type AutoRoleSkipReason = RoleAssignabilityReason | 'missing' | 'already';

/**
 * Entry point run from `handleFullyJoined` (non-pending join, or pending → not-pending after Discord's
 * membership screening). Picks the human/bot list, then either grants immediately or schedules the
 * `autorole-apply` job when `delaySeconds > 0`. Never throws — a failed auto-role must not break the join flow.
 */
export async function applyAutoRoles(
  ctx: PluginContext,
  member: GuildMember,
  config: RolesConfig,
): Promise<void> {
  const roleIds = selectAutoRoles({ isBot: member.user.bot, config: config.autoRoles });
  if (roleIds.length === 0) return;

  const guildId = member.guild.id;
  const userId = member.id;
  const delaySeconds = config.autoRoles.delaySeconds;

  if (delaySeconds > 0) {
    try {
      const data: AutoRoleJobData = { guildId, userId, roleIds };
      await ctx.queue(AUTO_ROLE_JOB_NAME).add(AUTO_ROLE_JOB_NAME, data, {
        jobId: autoRoleJobId(guildId, userId),
        delay: delaySeconds * 1000,
        removeOnComplete: true,
        // Without this, one failed run leaves the completed/failed job with this deterministic id sitting in
        // the queue forever, and every later join for the same guild+user silently no-ops (BullMQ refuses to
        // re-add a jobId that's already there) — auto-roles would just stop working for that pair.
        removeOnFail: true,
      });
    } catch (err) {
      ctx.logger.warn(
        { err: err instanceof Error ? err.message : String(err), guildId, userId },
        'roles: failed to schedule a delayed auto-role job',
      );
    }
    return;
  }

  await grantAutoRoles(ctx, member, roleIds, config.allowElevatedRoles);
}

/**
 * Actually grants `roleIds` to `member`, re-checking every role through `checkRoleAssignable` at assignment
 * time (roles can change after an admin configured them), dropping missing roles and ones the member already
 * holds. Writes a `roles.autorole.apply` audit row listing what was granted and what was skipped (with why).
 */
export async function grantAutoRoles(
  ctx: PluginContext,
  member: GuildMember,
  roleIds: string[],
  allowElevatedRoles: boolean,
): Promise<{ assigned: string[]; skipped: { roleId: string; reason: AutoRoleSkipReason }[] }> {
  const guild = member.guild;
  const botTopRolePosition = guild.members.me?.roles.highest.position ?? 0;

  const assignable: string[] = [];
  const skipped: { roleId: string; reason: AutoRoleSkipReason }[] = [];

  for (const roleId of roleIds) {
    // Cache first; only hit the REST API for the handful of ids the cache doesn't already have (every join
    // used to force a full-guild `roles.fetch()` here, which is wasteful at any real member-join volume).
    const role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
    if (!role) {
      skipped.push({ roleId, reason: 'missing' });
      continue;
    }
    if (member.roles.cache.has(roleId)) {
      skipped.push({ roleId, reason: 'already' });
      continue;
    }
    const result = checkRoleAssignable({
      permissionsBitfield: role.permissions.bitfield,
      position: role.position,
      managed: role.managed,
      botTopRolePosition,
      allowElevatedRoles,
    });
    if (result.ok) {
      assignable.push(roleId);
    } else {
      skipped.push({ roleId, reason: result.reason });
    }
  }

  if (assignable.length === 0) {
    return { assigned: [], skipped };
  }

  let assigned: string[] = assignable;
  let failed: string[] = [];
  try {
    await member.roles.add(assignable, 'Auto-role on join');
  } catch (err) {
    assigned = [];
    failed = assignable;
    ctx.logger.warn(
      { err: err instanceof Error ? err.message : String(err), guildId: guild.id, userId: member.id },
      'roles: failed to add auto-roles',
    );
  }

  await ctx.audit({
    guildId: guild.id,
    actorId: member.id,
    actorType: 'system',
    action: AUTO_ROLE_AUDIT_ACTION,
    targetType: 'member',
    targetId: member.id,
    after: { roleIds: assigned, skipped, ...(failed.length > 0 ? { failed } : {}) },
    source: 'bot',
  });

  return { assigned, skipped };
}

/** Renders `section` of the welcome/goodbye config for `member` in `guild`; returns null if that section is disabled or has nothing to send. */
export function renderWelcomeGoodbye(
  section: WelcomeGoodbyeConfig,
  member: { id: string; user: { tag?: string; username: string } },
  guild: Guild,
) {
  if (!section.enabled) return null;
  const vars = templateVarsFor(member, guild);
  const content = section.message ? renderTemplate(section.message, vars) : undefined;
  // `embed` is free-form Json: normalise the colour on the way out so a stored `#rrggbb` (what the dashboard
  // and older builds of the `/welcome embed` modal wrote) doesn't make Discord reject the entire message.
  const embed = section.embed
    ? normalizeStoredEmbed(renderTemplateDeep(section.embed, vars) as Record<string, unknown>)
    : undefined;
  if (!content && !embed) return null;
  return { content, embed };
}

/**
 * The slice of a discord.js `Message` the reaction reconciler needs. Structural (like `deliverWelcomeGoodbye`'s
 * `fetchUser`) so a freshly-sent message and a re-fetched one are the same shape here, and so it stays testable.
 */
interface PanelMessageLike {
  react: (emoji: string) => Promise<unknown>;
  reactions: {
    cache: {
      values: () => Iterable<{
        emoji: { id?: string | null; name?: string | null; animated?: boolean | null };
        /** True when the bot is one of the users who reacted with this emoji. */
        me: boolean;
        users: { remove: () => Promise<unknown> };
      }>;
    };
  };
}

async function deliverWelcomeGoodbye(params: {
  ctx: PluginContext;
  guild: Guild;
  channel: TextBasedChannel | null;
  member: { id: string; user: { tag?: string; username: string } };
  section: WelcomeGoodbyeConfig;
  // `never` (rather than `unknown`) as the `send` parameter type keeps this structurally assignable from a real
  // discord.js `User`/`GuildMember` (whose `.send` accepts a narrower, concrete payload type) — a function
  // accepting `unknown` would NOT be assignable from one accepting only `MessageCreateOptions | string` (that's
  // a real, correct contravariance error), but any function is assignable to a `(p: never) => X` parameter slot.
  fetchUser?: () => Promise<{ send: (payload: never) => Promise<unknown> } | null>;
}): Promise<{ sent: boolean; dmSent?: boolean }> {
  const { ctx, guild, channel, member, section } = params;
  const rendered = renderWelcomeGoodbye(section, member, guild);
  if (!rendered) return { sent: false };

  const payload = { content: rendered.content, embeds: rendered.embed ? [rendered.embed] : [] };
  let sent = false;

  if (channel && 'send' in channel) {
    try {
      await (channel as TextBasedChannel & { send: (p: unknown) => Promise<unknown> }).send(payload);
      sent = true;
    } catch (err) {
      ctx.logger.warn(
        { err: err instanceof Error ? err.message : String(err), guildId: guild.id },
        'roles: failed to send welcome/goodbye message',
      );
    }
  }

  let dmSent: boolean | undefined;
  if (section.dm && params.fetchUser) {
    const user = await params.fetchUser();
    if (user) {
      const result = await safeDm(user as never, payload as never);
      dmSent = result.sent;
    } else {
      dmSent = false;
    }
  }

  return { sent, dmSent };
}

export function createRolesService(ctx: PluginContext): RolesService {
  async function assignRolesCore(input: {
    guildId: string;
    userId: string;
    addRoleIds?: string[];
    removeRoleIds?: string[];
    reason?: string;
  }): Promise<void> {
    const guild = await ctx.client.guilds.fetch(input.guildId).catch(() => null);
    if (!guild) throw new NotFoundError('The bot is not in that server.');
    await guild.roles.fetch();
    const member = await guild.members.fetch(input.userId).catch(() => null);
    if (!member) throw new NotFoundError('That member is not in the server.');

    const config = await getRolesConfig(ctx, input.guildId);
    const addRoleIds = input.addRoleIds ?? [];
    const removeRoleIds = input.removeRoleIds ?? [];

    const { allowed: allowedToAdd, skipped } = filterAssignableRoles(
      guild,
      addRoleIds,
      config.allowElevatedRoles,
    );
    for (const skip of skipped) {
      ctx.logger.warn(
        { guildId: input.guildId, userId: input.userId, roleId: skip.roleId, reason: skip.reason },
        'roles: skipped an unsafe role assignment',
      );
    }

    if (allowedToAdd.length > 0) {
      await member.roles.add(allowedToAdd, input.reason).catch((err: unknown) => {
        ctx.logger.error(
          {
            err: err instanceof Error ? err.message : String(err),
            guildId: input.guildId,
            userId: input.userId,
          },
          'roles: failed to add roles',
        );
      });
    }
    if (removeRoleIds.length > 0) {
      await member.roles.remove(removeRoleIds, input.reason).catch((err: unknown) => {
        ctx.logger.error(
          {
            err: err instanceof Error ? err.message : String(err),
            guildId: input.guildId,
            userId: input.userId,
          },
          'roles: failed to remove roles',
        );
      });
    }
  }

  async function verifyMemberCore(input: { guildId: string; userId: string; method: string }): Promise<void> {
    const config = await getRolesConfig(ctx, input.guildId);

    if (config.verification.verifiedRoleId) {
      await assignRolesCore({
        guildId: input.guildId,
        userId: input.userId,
        addRoleIds: [config.verification.verifiedRoleId],
        reason: `Verified via ${input.method}`,
      });
    }

    const existing = await ctx.prisma.onboardingProgress.findUnique({
      where: { guildId_userId: { guildId: input.guildId, userId: input.userId } },
    });
    const progress = parseOnboardingProgress(existing?.steps);
    progress.verifiedAt = new Date().toISOString();

    await ctx.prisma.onboardingProgress.upsert({
      where: { guildId_userId: { guildId: input.guildId, userId: input.userId } },
      create: { guildId: input.guildId, userId: input.userId, steps: progress as never },
      update: { steps: progress as never },
    });

    await ctx.audit({
      guildId: input.guildId,
      actorId: input.userId,
      actorType: 'system',
      action: 'verification.event',
      targetType: 'member',
      targetId: input.userId,
      after: { method: input.method },
      source: 'bot',
    });

    ctx.events.emit('member.verified', {
      guildId: input.guildId,
      userId: input.userId,
      method: input.method,
    });
  }

  /**
   * Brings a posted REACTIONS panel's reactions in line with its current options: adds any the bot hasn't put
   * there yet, and drops its own reaction for options that are gone (a leftover emoji still looks clickable but
   * maps to nothing). Only the bot's own reactions are touched, so this needs no Manage Messages.
   */
  async function syncPanelReactions(message: PanelMessageLike, panel: PanelWithOptions): Promise<void> {
    const wanted = reactionRoleMap(panel).map(({ emoji }) => emoji);
    const wantedSet = new Set(wanted);
    const present = [...message.reactions.cache.values()];

    for (const reaction of present) {
      if (!reaction.me || wantedSet.has(panelEmojiKey(reaction.emoji))) continue;
      await reaction.users.remove().catch((err: unknown) => {
        ctx.logger.warn(
          { err: err instanceof Error ? err.message : String(err), guildId: panel.guildId, panelId: panel.id },
          'roles: failed to remove a stale reaction from a reaction-style panel',
        );
      });
    }

    for (const emoji of wanted) {
      const already = present.some((r) => r.me && panelEmojiKey(r.emoji) === emoji);
      if (already) continue;
      await message.react(emoji).catch((err: unknown) => {
        ctx.logger.warn(
          { err: err instanceof Error ? err.message : String(err), guildId: panel.guildId, panelId: panel.id },
          'roles: failed to add a reaction to a reaction-style panel',
        );
      });
    }
  }

  async function postPanelCore(guildId: string, panelId: string, requestedBy?: string): Promise<void> {
    const panel = await ctx.prisma.rolePanel.findFirst({
      where: { id: panelId, guildId, deletedAt: null },
      include: { options: { orderBy: { position: 'asc' } } },
    });
    if (!panel) throw new NotFoundError('Role panel not found.');
    if (panel.options.length === 0)
      throw new NotFoundError('This panel has no role options yet — add at least one before posting.');

    const guild = await ctx.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) throw new NotFoundError('The bot is not in that server.');

    const channel = await resolveTextChannel(guild, panel.channelId);
    if (!channel) {
      throw new NotFoundError(
        "I can't send messages in the configured channel — check it exists and I have View Channel + Send Messages there.",
      );
    }

    const payload = buildPanelMessagePayload(panel as PanelWithOptions);
    let messageId = panel.messageId;

    if (messageId) {
      const existingMessage = await channel.messages.fetch(messageId).catch(() => null);
      if (existingMessage) {
        await existingMessage.edit(payload as never);
        // A REACTIONS panel carries no components, so the edit alone would freeze the emoji set at whatever was
        // on the message when it was first posted — options added since would list in the embed with nothing to
        // click. Reconcile the reactions on every post, not just the first one.
        if (panel.style === 'REACTIONS') {
          await syncPanelReactions(existingMessage, panel as PanelWithOptions);
        }
      } else {
        messageId = null;
      }
    }

    if (!messageId) {
      const sent = await channel.send(payload as never);
      messageId = sent.id;

      if (panel.style === 'REACTIONS') {
        await syncPanelReactions(sent, panel as PanelWithOptions);
      }
    }

    await ctx.prisma.rolePanel.update({
      where: { id: panel.id },
      data: { messageId, channelId: channel.id },
    });

    ctx.logger.info({ guildId, panelId, requestedBy }, 'roles: posted role panel');
  }

  async function testWelcomeCore(
    guildId: string,
    requestedBy: string,
    channelId?: string,
    section: 'welcome' | 'goodbye' = 'welcome',
  ): Promise<void> {
    const config = await getRolesConfig(ctx, guildId);
    const guild = await ctx.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) throw new NotFoundError('The bot is not in that server.');

    const sectionConfig = section === 'goodbye' ? config.goodbye : config.welcome;
    const targetChannelId = channelId ?? sectionConfig.channelId;
    if (!targetChannelId) {
      throw new NotFoundError(`No ${section} channel is configured yet.`);
    }
    const channel = await resolveTextChannel(guild, targetChannelId);
    if (!channel) {
      throw new NotFoundError(
        "I can't send messages in that channel — check it exists and I have View Channel + Send Messages there.",
      );
    }

    const requester = await guild.members.fetch(requestedBy).catch(() => null);
    const member = requester ?? { id: requestedBy, user: { tag: 'Preview User', username: 'Preview User' } };

    const rendered = renderWelcomeGoodbye({ ...sectionConfig, enabled: true }, member as GuildMember, guild);
    const preview = rendered ?? {
      content: `_No ${section} message or embed is configured yet — this is a placeholder preview._`,
      embed: undefined,
    };

    await channel.send({
      content: `**[Preview]** ${preview.content ?? ''}`.trim(),
      embeds: preview.embed ? [preview.embed as never] : [],
    });
  }

  async function verificationDecisionCore(input: SdkVerificationDecisionInput): Promise<void> {
    // First check that the request exists; if not, fail immediately.
    const request = await ctx.prisma.verificationRequest.findFirst({
      where: { id: input.requestId, guildId: input.guildId },
    });
    if (!request) throw new NotFoundError('Verification request not found.');

    // Atomically update only if the status is still PENDING (prevents concurrent decisions from both succeeding).
    // `updateMany` returns the count of affected rows, so we can detect if the status changed since the read.
    const updated = await ctx.prisma.verificationRequest.updateMany({
      where: { id: input.requestId, status: 'PENDING' },
      data: {
        status: input.approve ? 'APPROVED' : 'DENIED',
        reviewedBy: input.reviewerId,
        reviewedAt: new Date(),
      },
    });

    if (updated.count === 0) {
      // Another moderator already decided this request (or it was manually updated).
      throw new AppError('already_decided', 'This verification request was already decided by another moderator.', {
        status: 409,
        expose: true,
      });
    }

    if (input.approve) {
      await verifyMemberCore({ guildId: input.guildId, userId: request.userId, method: 'modal' });
    }

    await ctx.audit({
      guildId: input.guildId,
      actorId: input.reviewerId,
      actorType: 'user',
      action: input.approve ? 'verification.approve' : 'verification.deny',
      targetType: 'verification_request',
      targetId: request.id,
      reason: input.note,
      source: 'bot',
    });

    const guild = await ctx.client.guilds.fetch(input.guildId).catch(() => null);
    const user = await guild?.client.users.fetch(request.userId).catch(() => null);
    if (user) {
      const outcome = input.approve ? 'approved' : 'denied';
      await safeDm(user, {
        embeds: [
          (input.approve ? successEmbed : errorEmbed)(
            `Your verification request for **${guild?.name ?? 'the server'}** was ${outcome}.${input.note ? `\n\nNote from staff: ${truncate(input.note, 500)}` : ''}`,
          ),
        ],
      });
    }

    if (request.staffMessageId && guild) {
      const config = await getRolesConfig(ctx, input.guildId);
      const staffChannelId = config.verification.staffChannelId;
      if (staffChannelId) {
        const staffChannel = await resolveTextChannel(guild, staffChannelId);
        const staffMessage = await staffChannel?.messages.fetch(request.staffMessageId).catch(() => null);
        if (staffMessage) {
          const decidedNote = `Decided by <@${input.reviewerId}> — **${input.approve ? 'Approved' : 'Denied'}**`;
          await staffMessage.edit({ content: decidedNote, components: [] }).catch(() => undefined);
        }
      }
    }
  }

  // --- Dual-calling-convention wrappers -------------------------------------------------------------------
  // apps/bot/src/host/bot-actions.ts (out of this plugin's ownership) dispatches every dashboard-queued
  // `bot-actions` job by calling the target service method with a SINGLE merged object argument
  // `{ guildId, payload, requestedBy }` — not the positional arguments this SDK interface declares
  // (`postPanel(guildId, panelId, requestedBy)`, etc). In-process callers (other plugins holding a real
  // `RolesService` reference) still call positionally per the declared type. Both shapes are supported here;
  // see README.md "Known integration gap" and this build's openIssues for a proposed host-side fix.
  function isBotActionObjectCall(
    args: unknown[],
  ): args is [{ guildId: string; payload?: unknown; requestedBy?: string }] {
    return (
      args.length === 1 && typeof args[0] === 'object' && args[0] !== null && 'guildId' in (args[0] as object)
    );
  }

  // `verificationDecision`'s real (positional) interface is ALREADY a single object
  // (`VerificationDecisionInput = { guildId, requestId, approve, reviewerId, note? }`), so the generic
  // "one object with a guildId key" check above can't disambiguate it from a bot-action call — both shapes
  // have a top-level `guildId`. Distinguish by the bot-action shape's `payload` wrapper, which the real
  // `VerificationDecisionInput` never has.
  function isBotActionVerificationCall(
    args: unknown[],
  ): args is [{ guildId: string; payload?: unknown; requestedBy?: string }] {
    if (!isBotActionObjectCall(args)) return false;
    const obj = args[0];
    return 'payload' in obj && !('requestId' in obj) && !('approve' in obj);
  }

  const postPanel = ((...args: unknown[]) => {
    if (isBotActionObjectCall(args)) {
      const { guildId, payload, requestedBy } = args[0];
      const panelId = (payload as { panelId?: string } | undefined)?.panelId ?? '';
      return postPanelCore(guildId, panelId, requestedBy);
    }
    const [guildId, panelId, requestedBy] = args as [string, string, string?];
    return postPanelCore(guildId, panelId, requestedBy);
  }) as RolesService['postPanel'];

  const testWelcome = ((...args: unknown[]) => {
    if (isBotActionObjectCall(args)) {
      const { guildId, payload, requestedBy } = args[0];
      const p = payload as { channelId?: string; section?: 'welcome' | 'goodbye' } | undefined;
      return testWelcomeCore(guildId, requestedBy ?? 'system', p?.channelId, p?.section ?? 'welcome');
    }
    const [guildId, requestedBy, channelId] = args as [string, string, string?];
    return testWelcomeCore(guildId, requestedBy, channelId, 'welcome');
  }) as RolesService['testWelcome'];

  const verificationDecision = ((...args: unknown[]) => {
    if (isBotActionVerificationCall(args)) {
      const { guildId, payload, requestedBy } = args[0];
      const p = payload as { requestId: string; approve: boolean; note?: string } | undefined;
      if (!p) throw new NotFoundError('Missing verification decision payload.');
      return verificationDecisionCore({
        guildId,
        requestId: p.requestId,
        approve: p.approve,
        reviewerId: requestedBy ?? 'system',
        note: p.note,
      });
    }
    const [input] = args as [SdkVerificationDecisionInput];
    return verificationDecisionCore(input);
  }) as RolesService['verificationDecision'];

  return {
    assignRoles: (input) => assignRolesCore(input),
    verifyMember: (input) => verifyMemberCore(input),
    postPanel,
    testWelcome,
    verificationDecision,
  };
}

export { deliverWelcomeGoodbye };
export type { Role, GuildMember };
