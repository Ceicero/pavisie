#!/usr/bin/env node
// Declaratively reconciles Brandon's Pavisie community hub Discord server against a plan JSON
// (infra/hub/hub-plan.json by default). Full usage, the plan schema, and idempotency notes live in
// infra/hub/README.md — read that first if you're changing this file or the plan.
//
// REST-only (no gateway login): @discordjs/rest + discord-api-types handle auth, requests, and rate limits.
// Every mutating call is guarded so --dry-run (the default) never writes anything — it still performs the
// same read-only GETs as --apply so the printed plan reflects real current server state, it just skips every
// POST/PATCH/PUT. Pure reconcile logic (plan validation, diffing, permission-overwrite computation, role
// ordering, message chunking) lives in scripts/lib/hub-setup-core.mjs so it can be unit-tested without a
// live Discord connection; this file is the thin I/O layer around it (arg parsing, env loading, the actual
// REST calls, and printing the summary).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REST, DiscordAPIError } from '@discordjs/rest';
import { Routes, ChannelType } from 'discord-api-types/v10';
import { config as dotenvConfig } from 'dotenv';
import * as hub from './lib/hub-setup-core.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(SCRIPT_DIR, '..');

// ---------------------------------------------------------------------------------------------------------
// Env loading — prefer @pavisie/core's loadEnv when this happens to run under a loader that can parse
// TypeScript workspace packages (e.g. tsx); under plain `node` that import always fails (workspace packages
// export raw .ts source with no build step, per docs/ARCHITECTURE.md §3, and root package.json intentionally
// does not depend on @pavisie/core), so we fall back to loading the repo-root .env with `dotenv` directly.
// Both paths are idempotent and never override a variable already present in process.env.
// ---------------------------------------------------------------------------------------------------------

async function tryLoadCoreEnv() {
  try {
    await import('@pavisie/core/env');
    return true;
  } catch {
    return false;
  }
}

function loadEnvFallback() {
  const envPath = path.join(REPO_ROOT, '.env');
  if (existsSync(envPath)) {
    dotenvConfig({ path: envPath, override: false });
  }
}

// ---------------------------------------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { plan: null, dryRun: false, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan') {
      args.plan = argv[++i];
    } else if (a.startsWith('--plan=')) {
      args.plan = a.slice('--plan='.length);
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--apply') {
      args.apply = true;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (args.dryRun && args.apply) {
    throw new Error('Pass only one of --dry-run or --apply, not both.');
  }
  if (!args.dryRun && !args.apply) {
    args.dryRun = true; // dry-run is the safe default when neither flag is given
  }
  if (!args.help && !args.plan) {
    throw new Error('Missing required --plan <path>');
  }
  return args;
}

// ---------------------------------------------------------------------------------------------------------
// Discord REST client wrapper — the only part of this script that talks to the network. Kept as a thin,
// swappable object (rather than calling `rest.*` inline throughout `runHubSetup`) so tests can pass a mocked
// client with the same method shape and exercise the full reconcile without a real bot token or network
// access (see scripts/__tests__/hub-setup.test.mjs).
// ---------------------------------------------------------------------------------------------------------

export function createDiscordClient(rest) {
  return {
    getRoles: (guildId) => rest.get(Routes.guildRoles(guildId)),
    getChannels: (guildId) => rest.get(Routes.guildChannels(guildId)),
    getBotMember: (guildId) => rest.get(Routes.guildMember(guildId, '@me')),
    getMessages: (channelId, limit = 20) =>
      rest.get(Routes.channelMessages(channelId), { query: new URLSearchParams({ limit: String(limit) }) }),
    createRole: (guildId, payload) => rest.post(Routes.guildRoles(guildId), { body: payload }),
    patchRole: (guildId, roleId, payload) => rest.patch(Routes.guildRole(guildId, roleId), { body: payload }),
    patchRolePositions: (guildId, positions) => rest.patch(Routes.guildRoles(guildId), { body: positions }),
    assignRole: (guildId, userId, roleId) => rest.put(Routes.guildMemberRole(guildId, userId, roleId)),
    createChannel: (guildId, payload) => rest.post(Routes.guildChannels(guildId), { body: payload }),
    patchChannel: (channelId, payload) => rest.patch(Routes.channel(channelId), { body: payload }),
    putChannelPermission: (channelId, overwriteId, payload) =>
      rest.put(Routes.channelPermission(channelId, overwriteId), { body: payload }),
    postMessage: (channelId, content) => rest.post(Routes.channelMessages(channelId), { body: { content } }),
  };
}

function isPermissionError(err) {
  if (err instanceof DiscordAPIError) return err.status === 403 || err.code === 50013 || err.code === 50001;
  return err?.status === 403;
}

function describeError(err) {
  if (err instanceof DiscordAPIError) return `Discord error ${err.code} (HTTP ${err.status}): ${err.message}`;
  return err?.message ?? String(err);
}

function describeItemError(label, err) {
  const suffix = isPermissionError(err)
    ? ' (permission denied — bot is missing a permission, or the target sits above the bot in the role hierarchy; skipped, run continues)'
    : '';
  return `${label}: ${describeError(err)}${suffix}`;
}

const NEW_ROLE_PREFIX = '<new-role:';
const NEW_CHANNEL_PREFIX = '<new-channel:';
const isPlaceholderId = (id) => typeof id === 'string' && (id.startsWith(NEW_ROLE_PREFIX) || id.startsWith(NEW_CHANNEL_PREFIX));

// ---------------------------------------------------------------------------------------------------------
// The reconcile itself. Always reads full current state first (GETs run in both --dry-run and --apply, so
// the printed dry-run plan reflects reality); every mutating call is behind `if (dryRun) { record; continue }
// else { try { call } catch { record error, continue } }` so a dry run never writes anything and an apply
// run never aborts on a single item's failure.
// ---------------------------------------------------------------------------------------------------------

export async function runHubSetup({ plan, client, dryRun }) {
  const report = { created: [], updated: [], skipped: [], noop: [], posted: [], errors: [], notes: [] };
  const idMap = { roles: {}, channels: {}, categories: {} };
  const guildId = plan.guildId;
  const everyoneId = guildId;

  let existingRoles;
  let existingChannels;
  let botMember;
  try {
    [existingRoles, existingChannels, botMember] = await Promise.all([
      client.getRoles(guildId),
      client.getChannels(guildId),
      client.getBotMember(guildId),
    ]);
  } catch (err) {
    throw new Error(`Failed to fetch current guild state: ${describeError(err)}`);
  }

  const botUserId = botMember?.user?.id;
  if (!botUserId) {
    throw new Error("Could not determine the bot's own user id from GET /guilds/{id}/members/@me — check DISCORD_TOKEN and that the bot is in the guild.");
  }

  const roleById = new Map(existingRoles.map((r) => [r.id, r]));
  const botRolePositions = (botMember.roles ?? [])
    .map((id) => roleById.get(id)?.position)
    .filter((p) => typeof p === 'number');
  const botTopPosition = botRolePositions.length > 0 ? Math.max(...botRolePositions) : 0;
  if (botTopPosition === 0) {
    report.notes.push(
      "The bot has no role above @everyone — it can't create/manage/reorder ANY roles until an admin drags the bot's own role above the roles it should manage.",
    );
  }

  // ---- Roles ----------------------------------------------------------------------------------------
  const roleSpecs = hub.normalizePlanRoles(plan);
  const existingRoleIdMap = plan.existing?.roles ?? {};
  const { actions: roleActions, notes: roleNotes } = hub.planRoleActions({
    specs: roleSpecs,
    existingRoles,
    existingIdMap: existingRoleIdMap,
    botTopPosition,
  });
  report.notes.push(...roleNotes);

  const roleNameToId = {};
  for (const action of roleActions) {
    if (action.type === 'create') {
      if (dryRun) {
        roleNameToId[action.name] = `${NEW_ROLE_PREFIX}${action.name}>`;
        report.created.push(`role "${action.name}" (would create)`);
        continue;
      }
      try {
        const created = await client.createRole(guildId, action.payload);
        roleNameToId[action.name] = created.id;
        idMap.roles[action.name] = created.id;
        report.created.push(`role "${action.name}" (id ${created.id})`);
      } catch (err) {
        report.errors.push(describeItemError(`create role "${action.name}"`, err));
      }
    } else if (action.type === 'update') {
      roleNameToId[action.name] = action.id;
      idMap.roles[action.name] = action.id;
      const fields = Object.keys(action.patch).join(', ');
      if (dryRun) {
        report.updated.push(`role "${action.name}" (would update: ${fields})`);
        continue;
      }
      try {
        await client.patchRole(guildId, action.id, action.patch);
        report.updated.push(`role "${action.name}" (updated: ${fields})`);
      } catch (err) {
        report.errors.push(describeItemError(`update role "${action.name}"`, err));
      }
    } else if (action.type === 'noop') {
      roleNameToId[action.name] = action.id;
      idMap.roles[action.name] = action.id;
      report.noop.push(`role "${action.name}" (already correct)`);
    } else if (action.type === 'skip_above_bot') {
      roleNameToId[action.name] = action.id;
      idMap.roles[action.name] = action.id;
      report.skipped.push(`role "${action.name}" — sits at/above the bot's own top role (id ${action.id}); left untouched`);
    }
  }

  const orderedRoleNames = roleSpecs.map((s) => s.name);
  const aboveBotNames = roleActions.filter((a) => a.type === 'skip_above_bot').map((a) => a.name);
  const { positions: rolePositions, skipped: positionSkipped } = hub.computeRolePositions({
    orderedNames: orderedRoleNames,
    nameToId: roleNameToId,
    skipNames: aboveBotNames,
    botTopPosition,
  });
  for (const name of positionSkipped) {
    if (!aboveBotNames.includes(name)) {
      report.notes.push(`role "${name}": no room below the bot's top role to position it — left where it is`);
    }
  }
  if (rolePositions.length > 0) {
    if (dryRun) {
      const order = orderedRoleNames.filter((n) => !aboveBotNames.includes(n) && !positionSkipped.includes(n));
      report.notes.push(`Would reorder ${rolePositions.length} role(s) below the bot's top role: ${order.join(' > ')}`);
    } else {
      try {
        await client.patchRolePositions(guildId, rolePositions);
        report.notes.push(`Reordered ${rolePositions.length} role(s) to match the plan hierarchy.`);
      } catch (err) {
        report.errors.push(describeItemError('reorder roles', err));
      }
    }
  }

  for (const spec of roleSpecs) {
    if (!spec.assignTo?.length) continue;
    const roleId = roleNameToId[spec.name];
    for (const userId of spec.assignTo) {
      if (dryRun || !roleId || isPlaceholderId(roleId)) {
        report.notes.push(`Would assign role "${spec.name}" to user ${userId}`);
        continue;
      }
      try {
        await client.assignRole(guildId, userId, roleId);
        report.notes.push(`Assigned role "${spec.name}" to user ${userId}`);
      } catch (err) {
        report.errors.push(describeItemError(`assign role "${spec.name}" to ${userId}`, err));
      }
    }
  }

  // ---- Categories & channels --------------------------------------------------------------------------
  const mutedRoleId = roleNameToId.Muted ?? existingRoleIdMap.Muted ?? null;
  const boosterRole = existingRoles.find((r) => r.tags && Object.hasOwn(r.tags, 'premium_subscriber'));
  const boosterRoleId = boosterRole?.id ?? null;
  if (!boosterRoleId) {
    report.notes.push('No premium-subscriber (booster) role exists in this guild yet — boosterOnly channels stay staff-only until the server has boosted.');
  }

  const workingChannels = [...existingChannels];
  const existingChannelIdMap = plan.existing?.channels ?? {};

  let categoryIndex = 0;
  for (const catSpec of plan.categories_in_order) {
    let categoryId;
    const existingCat = hub.resolveCategoryTarget({ spec: catSpec, existingChannels: workingChannels });

    if (!existingCat) {
      if (dryRun) {
        categoryId = `<new-category:${catSpec.name}>`;
        report.created.push(`category "${catSpec.name}" (would create, position ${categoryIndex})`);
      } else {
        try {
          const created = await client.createChannel(guildId, {
            name: catSpec.name,
            type: ChannelType.GuildCategory,
            position: categoryIndex,
          });
          categoryId = created.id;
          workingChannels.push(created);
          report.created.push(`category "${catSpec.name}" (id ${categoryId})`);
        } catch (err) {
          report.errors.push(describeItemError(`create category "${catSpec.name}"`, err));
          categoryIndex += 1;
          continue;
        }
      }
    } else {
      categoryId = existingCat.id;
      const { patch, hasChanges } = hub.computeCategoryPatch({ existing: existingCat, position: categoryIndex });
      if (hasChanges) {
        if (dryRun) {
          report.updated.push(`category "${catSpec.name}" (would update: ${Object.keys(patch).join(', ')})`);
        } else {
          try {
            await client.patchChannel(categoryId, patch);
            report.updated.push(`category "${catSpec.name}" (updated: ${Object.keys(patch).join(', ')})`);
          } catch (err) {
            report.errors.push(describeItemError(`update category "${catSpec.name}"`, err));
          }
        }
      } else {
        report.noop.push(`category "${catSpec.name}" (already correct)`);
      }
    }
    idMap.categories[catSpec.name] = categoryId;
    categoryIndex += 1;

    let channelIndex = 0;
    for (const chSpec of catSpec.channels) {
      const existingCh = hub.resolveChannelTarget({
        spec: chSpec,
        existingChannels: workingChannels,
        existingIdMap: existingChannelIdMap,
      });

      let channelId;
      if (!existingCh) {
        const payload = hub.computeChannelCreatePayload({
          spec: chSpec,
          categoryId: isPlaceholderId(categoryId) ? null : categoryId,
          position: channelIndex,
          channelType: chSpec.type,
        });
        if (dryRun) {
          channelId = `${NEW_CHANNEL_PREFIX}${chSpec.name}>`;
          report.created.push(`#${chSpec.name} (would create in "${catSpec.name}")`);
        } else {
          try {
            const created = await client.createChannel(guildId, payload);
            channelId = created.id;
            workingChannels.push(created);
            report.created.push(`#${chSpec.name} (id ${channelId})`);
          } catch (err) {
            report.errors.push(describeItemError(`create channel "${chSpec.name}"`, err));
            channelIndex += 1;
            continue;
          }
        }
      } else {
        channelId = existingCh.id;
        const { patch, notes: patchNotes, hasChanges } = hub.computeChannelPatch({
          existing: existingCh,
          spec: chSpec,
          categoryId,
          position: channelIndex,
          channelType: chSpec.type,
        });
        report.notes.push(...patchNotes);
        if (hasChanges) {
          if (dryRun) {
            report.updated.push(`#${existingCh.name} (would update: ${Object.keys(patch).join(', ')})`);
          } else {
            try {
              await client.patchChannel(channelId, patch);
              report.updated.push(`#${existingCh.name} (updated: ${Object.keys(patch).join(', ')})`);
            } catch (err) {
              report.errors.push(describeItemError(`update channel "${chSpec.name}"`, err));
            }
          }
        } else {
          report.noop.push(`#${chSpec.name} (already correct)`);
        }
      }
      idMap.channels[chSpec.name] = channelId;
      channelIndex += 1;

      const { overwrites, notes: owNotes } = hub.computeChannelOverwrites({
        spec: chSpec,
        channelType: chSpec.type,
        roleNameToId,
        everyoneId,
        mutedRoleId,
        mutedDenyList: plan.mutedOverwrites.deny,
        botUserId,
        boosterRoleId,
      });
      report.notes.push(...owNotes);

      for (const ow of overwrites) {
        if (dryRun || isPlaceholderId(channelId) || isPlaceholderId(ow.id)) {
          report.notes.push(`Would set permission overwrite on #${chSpec.name} for ${ow.type === 0 ? 'role' : 'member'} ${ow.id}`);
          continue;
        }
        try {
          await client.putChannelPermission(channelId, ow.id, { type: ow.type, allow: ow.allow, deny: ow.deny });
        } catch (err) {
          report.errors.push(describeItemError(`set overwrite on #${chSpec.name} for ${ow.id}`, err));
        }
      }
    }
  }

  // ---- Pinned messages ---------------------------------------------------------------------------------
  const messageTargets = [
    { channelName: 'rules', lines: plan.messages?.rules },
    { channelName: 'faq', lines: plan.messages?.faqSticky ? [plan.messages.faqSticky] : null },
    { channelName: 'ai-chat', lines: plan.messages?.aiChatIntro ? [plan.messages.aiChatIntro] : null },
    { channelName: 'booster-lounge', lines: plan.messages?.boosterThanks ? [plan.messages.boosterThanks] : null },
  ];

  for (const target of messageTargets) {
    if (!target.lines?.length) continue;
    const channelId = idMap.channels[target.channelName];
    if (!channelId) {
      report.notes.push(`Message for #${target.channelName} skipped — that channel's id is unknown (its create/update step above failed)`);
      continue;
    }
    if (isPlaceholderId(channelId)) {
      report.notes.push(`Would check #${target.channelName} for an existing bot post and post the plan message if none is found (channel doesn't exist yet)`);
      continue;
    }

    let alreadyPosted = false;
    try {
      const recent = await client.getMessages(channelId, 20);
      alreadyPosted = hub.hasBotPosted(recent, botUserId);
    } catch (err) {
      report.errors.push(describeItemError(`check existing messages in #${target.channelName}`, err));
      continue;
    }
    if (alreadyPosted) {
      report.noop.push(`#${target.channelName} message (bot already posted — left alone)`);
      continue;
    }

    const chunks = hub.chunkMessage(target.lines);
    if (dryRun) {
      report.notes.push(`Would post ${chunks.length} message(s) to #${target.channelName} (no prior bot post found)`);
      continue;
    }
    for (const content of chunks) {
      try {
        await client.postMessage(channelId, content);
        report.posted.push(`#${target.channelName} (${content.length} chars)`);
      } catch (err) {
        report.errors.push(describeItemError(`post message to #${target.channelName}`, err));
      }
    }
  }

  return { report, idMap };
}

// ---------------------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------------------

function printReport(report, { dryRun }) {
  const section = (title, items) => {
    if (!items.length) return;
    console.log(`\n${title} (${items.length})`);
    for (const item of items) console.log(`  - ${item}`);
  };

  console.log(`\n${dryRun ? '[DRY RUN] ' : ''}hub-setup reconcile summary`);
  section('Created', report.created);
  section('Updated', report.updated);
  section('Posted messages', report.posted);
  section('Skipped', report.skipped);
  section('Already correct', report.noop);
  section('Notes', report.notes);
  section('Errors', report.errors);
  console.log(
    `\nTotals: ${report.created.length} created, ${report.updated.length} updated, ${report.posted.length} posted, ` +
      `${report.skipped.length} skipped, ${report.noop.length} unchanged, ${report.errors.length} errors.`,
  );
}

// ---------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error('\nUsage: node scripts/hub-setup.mjs --plan <path> [--dry-run | --apply]');
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    console.log('Usage: node scripts/hub-setup.mjs --plan <path> [--dry-run | --apply]');
    console.log('  --plan <path>  Path to the hub plan JSON (e.g. infra/hub/hub-plan.json).');
    console.log('  --dry-run      Print what would change; write nothing. Default when neither flag is given.');
    console.log('  --apply        Actually create/update roles, channels, overwrites, and messages.');
    return;
  }

  const usedCoreEnv = await tryLoadCoreEnv();
  if (!usedCoreEnv) loadEnvFallback();

  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error(
      'DISCORD_TOKEN is not set.\n' +
        'Copy .env.example to .env at the repo root and fill in DISCORD_TOKEN\n' +
        '(Discord Developer Portal -> your application -> Bot -> Reset Token), then re-run this script.',
    );
    process.exitCode = 1;
    return;
  }

  const planPath = path.isAbsolute(args.plan) ? args.plan : path.join(process.cwd(), args.plan);
  let plan;
  try {
    plan = JSON.parse(await readFile(planPath, 'utf8'));
  } catch (err) {
    console.error(`Could not read/parse plan file at ${planPath}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const validation = hub.validatePlan(plan);
  if (!validation.ok) {
    console.error('Plan validation failed:');
    for (const e of validation.errors) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }

  const rest = new REST({ version: '10' }).setToken(token);
  const client = createDiscordClient(rest);

  console.log(`${args.dryRun ? 'Dry run' : 'Applying'} hub-setup against guild ${plan.guildId} using plan ${planPath}`);

  let result;
  try {
    result = await runHubSetup({ plan, client, dryRun: args.dryRun });
  } catch (err) {
    console.error(`Fatal: ${describeError(err)}`);
    process.exitCode = 1;
    return;
  }

  printReport(result.report, { dryRun: args.dryRun });

  if (args.dryRun) {
    console.log('\n[DRY RUN] Nothing was written or changed. Re-run with --apply to perform this reconcile.');
  } else {
    const outPath = path.join(REPO_ROOT, 'infra', 'hub', 'hub-ids.json');
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(result.idMap, null, 2)}\n`, 'utf8');
    console.log(`\nWrote id map to ${path.relative(REPO_ROOT, outPath)}`);
  }

  process.exitCode = result.report.errors.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
