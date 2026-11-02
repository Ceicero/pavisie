import { definePlugin, registerPluginLocales } from '../sdk';
import { manifest } from './manifest';
import { command as pollCommand } from './commands/poll';
import { command as giveawayCommand } from './commands/giveaway';
import { command as suggestCommand } from './commands/suggest';
import { command as suggestionsCommand } from './commands/suggestions';
import { command as announceCommand } from './commands/announce';
import { command as remindCommand } from './commands/remind';
import { command as eventCommand } from './commands/event';
import { command as tagCommand } from './commands/tag';
import { command as stickyCommand } from './commands/sticky';
import { command as channelAutoCommand } from './commands/channels';
import { channelAutomationsHandler } from './events/channel-automations';
import { command as statsChannelCommand } from './commands/statschannel';
import { command as birthdayCommand } from './commands/birthday';
import { pollComponents } from './components/poll';
import { giveawayComponents } from './components/giveaway';
import { suggestionComponents } from './components/suggestion';
import { eventComponents } from './components/event';
import { tagComponents } from './components/tag-modal';
import { tagTriggersHandler } from './events/tag-triggers';
import { stickyComponents } from './components/sticky';
import { stickyMessageCreateHandler, stickyChannelDeleteHandler } from './events/sticky';
import { pollEndJob } from './jobs/poll-end';
import { giveawayEndJob } from './jobs/giveaway-end';
import { announcementRunJob } from './jobs/announcement-run';
import { reminderDeliverJob } from './jobs/reminder-deliver';
import { reminderSweepJob } from './jobs/reminder-sweep';
import { communityCatchupJob } from './jobs/community-catchup';
import { eventReminderJob } from './jobs/event-reminder';
import { suggestionSyncJob } from './jobs/suggestion-sync';
import { stickyRepostJob } from './jobs/sticky-repost';
import { statsRefreshJob } from './jobs/stats-refresh';
import { birthdayAnnounceJob } from './jobs/birthday-announce';
import { birthdayRoleRemoveJob } from './jobs/birthday-role-remove';
import en from './locales/en.json';

// Registers the `community` locale bundle (see admin/index.ts for the same pattern).
registerPluginLocales('community', { en });

export const plugin = definePlugin({
  manifest,
  commands: [
    pollCommand,
    giveawayCommand,
    suggestCommand,
    suggestionsCommand,
    announceCommand,
    remindCommand,
    eventCommand,
    tagCommand,
    stickyCommand,
    channelAutoCommand,
    statsChannelCommand,
    birthdayCommand,
  ],
  components: [
    ...pollComponents,
    ...giveawayComponents,
    ...suggestionComponents,
    ...eventComponents,
    ...tagComponents,
    ...stickyComponents,
  ],
  events: [tagTriggersHandler, stickyMessageCreateHandler, stickyChannelDeleteHandler, channelAutomationsHandler],
  jobs: [
    pollEndJob,
    giveawayEndJob,
    announcementRunJob,
    reminderDeliverJob,
    reminderSweepJob,
    communityCatchupJob,
    eventReminderJob,
    suggestionSyncJob,
    stickyRepostJob,
    statsRefreshJob,
    birthdayAnnounceJob,
    birthdayRoleRemoveJob,
  ],
  async health(ctx) {
    // Tag auto-responders need the Message Content intent. Only report degraded when some guild has actually
    // opted into triggers (`tags.triggersEnabled`) — otherwise nothing is limited. Falls back to the cheap
    // "intent off" check if the JSON-path query is unavailable (e.g. a stub prisma in tests).
    if (!ctx.intentsEnabled.messageContent) {
      let optedIn = 1;
      try {
        optedIn = await ctx.prisma.pluginConfig.count({
          where: { pluginId: 'community', config: { path: ['tags', 'triggersEnabled'], equals: true } },
        });
      } catch {
        optedIn = 1;
      }
      if (optedIn > 0) {
        return {
          status: 'degraded',
          details:
            'Tag auto-responders need the Message Content privileged intent, which is off — `/tag show` still works; keyword triggers are inactive.',
        };
      }
    }
    return { status: 'ok' };
  },
});

export default plugin;
