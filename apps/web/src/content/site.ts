// Site-wide copy that isn't generated from the plugin registry (ARCHITECTURE.md §17).

export const siteCopy = {
  tagline: 'The modular, compliance-first Discord bot for gaming communities.',
  heroTitle: 'Moderation your server can actually trust.',
  heroSubtitle:
    'Pavisie is an all-in-one Discord bot: moderation, automod, a policy-driven Enforcer, tickets, roles, leveling, and more — every module opt-in, every action logged, never Administrator. Start with +help.',
  whyGaming: {
    title: 'Built for gaming communities',
    intro:
      'Raids, toxic lobbies, tournament brackets, LFG spam, streamer alerts, and a leaderboard everyone actually checks — Pavisie is shaped around what a game server deals with every single day.',
    points: [
      {
        title: 'Raids & toxicity',
        body: 'Automod and the policy-driven Enforcer catch spam, invite drops, and rule violations fast, with dry-run tuning and a false-positive review queue so enforcement stays accurate, not trigger-happy.',
      },
      {
        title: 'Tournaments & LFG',
        body: 'Role panels sort players by game and rank, giveaways run fair prize drops, tickets handle bracket disputes, and community tools schedule scrims across timezones.',
      },
      {
        title: 'Streamer alerts',
        body: 'Optional Twitch and YouTube integrations post a clean "going live" alert the moment a member starts streaming — no polling scripts, no scraping.',
      },
      {
        title: 'Leveling that matters',
        body: 'Anti-farm XP, reputation, and a starboard reward the players who actually show up and contribute, not the ones who spam the loudest channel.',
      },
      {
        title: 'Tickets that don\'t get lost',
        body: 'Button-driven support with staff assignment and transcripts means a player report or ban appeal never just falls off the bottom of a channel.',
      },
      {
        title: 'A record you can show sponsors',
        body: 'Every moderation action and every Enforcer decision is written to an append-only, exportable record — useful the moment a community grows past "just friends".',
      },
    ],
  },
  trust: {
    title: 'Trust & compliance',
    intro:
      'The moat here is trust, not features. Pavisie is built so a server owner never has to just take our word for it.',
    points: [
      {
        title: 'Never Administrator',
        body: 'The bot requests a least-privilege permission set, documented per feature. It never asks for the Administrator permission, full stop.',
      },
      {
        title: 'Privacy-first defaults',
        body: 'Logging defaults to metadata only — message content is never stored unless a feature explicitly needs it and a server admin turns it on. Enforcer stores a sanitized excerpt and a short context snapshot for each flag because moderators must be able to review it later; that\'s disclosed in the plugin, and context capture can be switched off in settings.',
      },
      {
        title: 'Ledgered moderation',
        body: 'Every moderation case and every Enforcer flag/decision gets an immutable case or record number, exportable as CSV, searchable by staff.',
      },
      {
        title: 'Full audit trail',
        body: 'Config changes, plugin enables/disables, and dashboard actions all write to a full audit trail — "who changed this, and when" always has an answer.',
      },
      {
        title: 'Open about what\'s optional',
        body: 'Economy is virtual currency only, disabled by default, never real money. Media, AI, and integrations only activate once a server explicitly opts in and configures them.',
      },
    ],
  },
  prefix: {
    symbol: '+',
    helpCommand: '+help',
    eyebrow: 'Getting started',
    title: 'Type +help. That is the whole tutorial.',
    body: 'Every Pavisie command works two ways: type it in chat with a + prefix (like +help, +mod ban @user spam) or use the / slash-command menu. The + prefix exists because a busy server\'s slash menu is crowded with other bots — you can type faster, and the command reference is always a single +help away. Every command, every time, both ways.',
    examples: [
      { command: '+help', label: 'Lists every command and plugin' },
      { command: '+mod ban @user spam', label: 'Moderation with context' },
      { command: '+setup wizard', label: 'First-time configuration' },
      { command: '+config view', label: 'Review server settings' },
    ],
  },
  staffRoles: {
    eyebrow: 'Staff roles & permissions',
    title: 'Control who can run what. Never give a bot Administrator.',
    intro:
      'Pavisie has four staff tiers you assign — member, helper, moderator and admin — plus the server owner, who always has everything. Each tier controls what commands a user can run. A member can only affect themselves or things they own. Every tier is optional, and every role is one of your server\'s own Discord roles attached to one of these tiers.',
    tiers: [
      {
        name: 'Member',
        label: 'Everyone (no role needed)',
        description: 'The default tier. A member can run commands that affect themselves or that they own.',
        commands: [
          '+help, +ask, +summarize, +appeal, +verify, +suggest, +remind, +dbd',
          '+utility (server/user info, their own timezone)',
          '+level rank, +level leaderboard',
          '+rep give, +rep check, +rep leaderboard',
          '+birthday set, +birthday remove, +birthday view, +birthday upcoming',
          '+economy balance, +economy daily, +economy give, +economy leaderboard',
          '+tag show, +tag list, +tag info',
          '+music (subject to a DJ-role gate)',
          '+poll create, and ending their own poll',
          '+ticket open, and closing/reopening/transcripting their own ticket',
          '+tempvoice lock/unlock/limit/rename/kick/permit on their own claimed voice channel',
        ],
        detail:
          'Key point: members can only manage things they own. Closing a ticket, ending a poll, or managing a temp voice channel all check ownership — otherwise the action needs staff.',
      },
      {
        name: 'Helper',
        label: 'First rung of staff',
        description: 'Everything a member can do, plus enforcement tooling.',
        commands: [
          'All member commands',
          '+automod, +draft, +event',
          'Milder +mod actions: warnings, notes, viewing cases',
          '+tag create',
          '+ticket add, +ticket remove, +ticket assign, and closing other people\'s tickets',
        ],
        detail: '',
      },
      {
        name: 'Moderator',
        label: 'Real enforcement power',
        description: 'Everything helper can do, plus the full moderation toolkit.',
        commands: [
          'All helper commands',
          '+mod (15 actions): ban, kick, timeout, purge, lock, slowmode, nickname, and more',
          '+announce, +giveaway, +logs, +health, +roles, +welcome, +goodbye, +verification, +sticky, +suggestions, +mod-assist',
          '+ticket config and creating ticket panels',
          '+tag edit, +tag delete',
          '+economy admin adjustments and config',
          '+onboarding config, +level config/reset',
          'Ending anyone\'s poll',
        ],
        detail: '',
      },
      {
        name: 'Admin',
        label: 'Bot configuration',
        description: 'Everything moderator can do, plus the power to configure Pavisie itself.',
        commands: [
          'All moderator commands',
          '+setup, +config, +plugin, +permissions, +pavisie, +ai',
          '+starboard, +statschannel, +channelauto',
          '+integration, +twitch (also accept Manage Server permission as an alternative)',
          '+tag trigger, +tempvoice setup, +birthday config',
        ],
        detail: '',
      },
    ],
    setupTitle: 'How to attach a role to a tier',
    setupIntro:
      'Pavisie does not create roles — you use your server\'s own existing Discord roles. Attach a role to a tier, and every user with that role gets those powers.',
    setupMethods: [
      {
        method: 'Guided (recommended)',
        description: 'Run the interactive wizard:',
        commands: ['+setup wizard', 'or: /setup wizard'],
      },
      {
        method: 'Direct configuration',
        description: 'Set each tier\'s role directly:',
        commands: [
          '+config set key:guild.helperRoleIds value:@YourHelperRole',
          '+config set key:guild.modRoleIds value:@YourModRole',
          '+config set key:guild.adminRoleIds value:@YourAdminRole',
        ],
      },
    ],
    setupVerify:
      'Check the result with +config view, and audit the whole picture with +permissions. Until you attach a role to a tier, only the Discord server owner has those powers.',
    ownerNote: 'The Discord server owner is always the Owner tier and cannot be locked out.',
  },
  donateCta: {
    title: 'Help keep Pavisie running',
    body: 'Pavisie is community-run. Donations fund hosting and development — they\'re one-time, non-refundable, and grant no perks or in-game advantages.',
  },
  footer: {
    tagline: 'Community-run Discord moderation, built in the open.',
  },
} as const;
