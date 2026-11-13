import { definePlugin, registerPluginLocales } from '../sdk';
import { manifest } from './manifest';
import { command as automodCommand } from './commands/automod';
import { automodComponents } from './components';
import { messageCreateHandler } from './events/message-create';
import { messageUpdateHandler } from './events/message-update';
import { memberAddHandler } from './events/member-add';
import { eventsRetentionJob } from './jobs/events-retention';
import { raidAlertJob } from './raid-alert';
import { createAutomodService, startRuleSync } from './service';
import * as ruleSchemas from './schemas';
import en from './locales/en.json';

// Registers the `automod` locale bundle (core `t('automod.<key>', ...)`); see packages/plugins/src/sdk/locales.ts.
registerPluginLocales('automod', { en });

/**
 * Every per-rule-type config schema, re-exported as the single source of truth (TASK: "export them from the
 * plugin's index.ts as 'automodRuleSchemas' (+ types); then make apps/api/src/lib/automod-schemas.ts re-export
 * from '@pavisie/plugins' so there is one source of truth").
 */
export const automodRuleSchemas = ruleSchemas;
export type { AutomodAction, AutomodActionType, AutomodRuleConfig, AutomodRuleTypeValue } from './schemas';
export * from './engine';

export const plugin = definePlugin({
  manifest,
  commands: [automodCommand],
  events: [messageCreateHandler, messageUpdateHandler, memberAddHandler],
  components: automodComponents,
  jobs: [eventsRetentionJob, raidAlertJob],
  async onLoad(ctx) {
    ctx.services.register('automod', createAutomodService(ctx));
    // Dashboard rule edits reach this process over Redis. If the subscription cannot be set up the plugin still
    // works: edits then take effect when the short-lived rule cache expires, as they did before.
    await startRuleSync(ctx).catch((err: unknown) => {
      ctx.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'automod: could not subscribe to rule changes; dashboard edits will apply within a few seconds instead of at once',
      );
    });
  },
  async health(ctx) {
    // A meaningful health signal beyond "the plugin loaded": are there any *enabled* rules that are currently
    // inactive because a privileged intent they need isn't on? That's degraded, not broken — matches still get
    // evaluated for every other rule.
    try {
      const enabledCount = await ctx.prisma.automodRule.count({ where: { enabled: true, deletedAt: null } });
      if (enabledCount === 0) {
        return { status: 'ok', details: 'No enabled rules yet.' };
      }
      return { status: 'ok', details: `${enabledCount} enabled rule(s) across all guilds.` };
    } catch (err) {
      return {
        status: 'degraded',
        details: err instanceof Error ? err.message : 'Could not query automod rules.',
      };
    }
  },
});

export default plugin;
