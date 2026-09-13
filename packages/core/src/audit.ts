/** Dot-namespaced audit action identifiers used across bot, api, and dashboard writes. */
export const AuditAction = {
  ConfigUpdate: 'config.update',
  ConfigReset: 'config.reset',
  PluginEnable: 'plugin.enable',
  PluginDisable: 'plugin.disable',
  PluginConfigUpdate: 'plugin.config.update',
  ModerationCaseCreate: 'moderation.case.create',
  ModerationCaseUpdate: 'moderation.case.update',
  ModerationWarningClear: 'moderation.warning.clear',
  ModerationAppealCreate: 'moderation.appeal.create',
  ModerationAppealApprove: 'moderation.appeal.approve',
  ModerationAppealDeny: 'moderation.appeal.deny',
  AutomodRuleCreate: 'automod.rule.create',
  AutomodRuleUpdate: 'automod.rule.update',
  AutomodRuleDelete: 'automod.rule.delete',
  AutomodEventReview: 'automod.event.review',
  LoggingSettingsUpdate: 'logging.settings.update',
  TicketSettingsUpdate: 'ticket.settings.update',
  TicketPanelCreate: 'ticket.panel.create',
  RolesPanelCreate: 'roles.panel.create',
  RolesPanelUpdate: 'roles.panel.update',
  RolesPanelDelete: 'roles.panel.delete',
  RolesWelcomeUpdate: 'roles.welcome.update',
  RolesAutoRoleUpdate: 'roles.autorole.update',
  VerificationApprove: 'verification.approve',
  VerificationDeny: 'verification.deny',
  IntegrationConnect: 'integration.connect',
  IntegrationDisconnect: 'integration.disconnect',
  IntegrationWebhookCreate: 'integration.webhook.create',
  IntegrationWebhookDelete: 'integration.webhook.delete',
  AiSettingsUpdate: 'ai.settings.update',
  CommunityStickySet: 'community.sticky.set',
  CommunityStickyRemove: 'community.sticky.remove',
  RetentionUpdate: 'retention.update',
  DataExportRequest: 'data.export.request',
  DataDeleteRequest: 'data.delete.request',
  SetupWizardComplete: 'setup.wizard.complete',
  CommunityTagCreate: 'community.tag.create',
  CommunityTagUpdate: 'community.tag.update',
  CommunityTagDelete: 'community.tag.delete',
  CommunityBirthdayConfigUpdate: 'community.birthday.config.update',
  CommunityBirthdayRemove: 'community.birthday.remove',
  // An admin setting another member's birthday (self-service sets are never audited — see birthday.ts).
  CommunityBirthdaySet: 'community.birthday.set',
  DeveloperReportSubmit: 'developer_report.submit',
} as const;

/** Union of all `AuditAction` string values. */
export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

/** A single audit trail entry. Persistence (writeAudit) lives in `@pavisie/database`. */
export interface AuditEntry {
  id?: string;
  guildId: string;
  actorId: string;
  actorType: 'user' | 'system';
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  source: 'bot' | 'dashboard' | 'system';
  createdAt?: Date;
}
