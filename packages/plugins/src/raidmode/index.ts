import { definePlugin, registerPluginLocales, type PluginEventHandler } from '../sdk';
import { command as raidModeCommand } from './commands/raidmode';
import { raidModeComponents } from './components';
import { handleJoin, purgeJob, updateJob } from './incident';
import { manifest } from './manifest';
import en from './locales/en.json';

registerPluginLocales('raidmode', { en });

/** `guildMemberAdd`: one Redis round trip per join; see state.ts. */
const memberAddHandler: PluginEventHandler<'guildMemberAdd'> = {
  event: 'guildMemberAdd',
  guildIdOf: (member) => member.guild.id,
  async handler(ctx, member) {
    await handleJoin(ctx, member);
  },
};

export const plugin = definePlugin({
  manifest,
  commands: [raidModeCommand],
  events: [memberAddHandler],
  components: raidModeComponents,
  jobs: [updateJob, purgeJob],
});

export { handleJoin } from './incident';
export default plugin;
