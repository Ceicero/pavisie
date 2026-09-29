import { definePlugin, registerPluginLocales } from '../sdk';
import { manifest } from './manifest';
import { command as economyCommand } from './commands/economy';
import en from './locales/en.json';

registerPluginLocales('economy', { en });

export const plugin = definePlugin({
  manifest,
  commands: [economyCommand],
  async health() {
    return { status: 'ok' };
  },
});

export default plugin;
