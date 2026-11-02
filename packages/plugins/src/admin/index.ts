import { definePlugin, registerPluginLocales } from '../sdk';
import { manifest } from './manifest';
import { command as setupCommand } from './commands/setup';
import { command as configCommand } from './commands/config';
import { command as pluginCommand } from './commands/plugin';
import { command as permissionsCommand } from './commands/permissions';
import { command as healthCommand } from './commands/health';
import { command as reportCommand } from './commands/report';
import { wizardComponents } from './components/wizard';
import { reportComponents } from './components/report';
import { retentionSweepJob } from './jobs/retention-sweep';
import { createAdminService } from './service';
import en from './locales/en.json';

// Registers the `admin` locale bundle into the shared i18n table (core `t('admin.<key>', ...)`), and the host's
// per-plugin `CommandContext.t` is expected to use the same "try `<pluginId>.<key>`, then core `<key>`" fallback
// this call enables (see `registerPluginLocales` in ../sdk/locales.ts).
registerPluginLocales('admin', { en });

export const plugin = definePlugin({
  manifest,
  commands: [setupCommand, configCommand, pluginCommand, permissionsCommand, healthCommand, reportCommand],
  components: [...wizardComponents, ...reportComponents],
  jobs: [retentionSweepJob],
  async onLoad(ctx) {
    ctx.services.register('admin', createAdminService(ctx));
  },
  async health() {
    // `admin` is always enabled and has no external dependency of its own; its /health command is what actually
    // probes redis/db/gateway. This just reports "the plugin itself loaded fine".
    return { status: 'ok' };
  },
});

export default plugin;
