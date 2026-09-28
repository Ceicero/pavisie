import { definePlugin, registerPluginLocales } from '../sdk';
import { manifest } from './manifest';
import { command as economyCommand } from './commands/economy';
import { EconomyServiceImpl } from './service';
import en from './locales/en.json';

registerPluginLocales('economy', { en });

export const plugin = definePlugin({
  manifest,
  commands: [economyCommand],
  async onLoad(ctx) {
    const service = new EconomyServiceImpl(ctx.prisma, (guildId) => ctx.getConfig(guildId));
    ctx.services.register('economy', service);
  },
  async health() {
    return { status: 'ok' };
  },
});

export default plugin;
