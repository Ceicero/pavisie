import { definePlugin, registerPluginLocales } from '../sdk';
import { manifest } from './manifest';
import { command as levelCommand, levelComponents } from './commands/level';
import { command as repCommand } from './commands/rep';
import { command as starboardCommand } from './commands/starboard';
import { command as tempvoiceCommand } from './commands/tempvoice';
import { messageCreateHandler } from './events/message-create';
import { voiceStateUpdateHandler } from './events/voice-state-update';
import { messageReactionAddHandler, messageReactionRemoveHandler } from './events/reactions';
import { rewardReconcileJob } from './jobs/reward-reconcile';
import { tempVoiceSweepJob } from './jobs/tempvoice-sweep';
import en from './locales/en.json';

registerPluginLocales('engagement', { en });

export const plugin = definePlugin({
  manifest,
  commands: [levelCommand, repCommand, starboardCommand, tempvoiceCommand],
  components: [...levelComponents],
  events: [
    messageCreateHandler,
    voiceStateUpdateHandler,
    messageReactionAddHandler,
    messageReactionRemoveHandler,
  ],
  jobs: [tempVoiceSweepJob, rewardReconcileJob],
  async health(ctx) {
    try {
      await ctx.redis.ping();
      return { status: 'ok' };
    } catch (err) {
      return { status: 'degraded', details: err instanceof Error ? err.message : String(err) };
    }
  },
});

export default plugin;
