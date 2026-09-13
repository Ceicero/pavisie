// Copy for the `/enforcer` spotlight page (ARCHITECTURE.md §17, §19; SPEC.md §N).

export interface WorkflowStep {
  title: string;
  body: string;
}

export const enforcerWorkflow: WorkflowStep[] = [
  {
    title: '1. Policy',
    body: 'A server admin writes a policy: what it matches (keywords, regex, link domains, invites, mention counts, attachment types), which channels it watches, who is exempt, and a suggested action. No slur lists ship with Pavisie — servers bring their own.',
  },
  {
    title: '2. Flag',
    body: 'A message matching a policy — or a moderator using the "Flag for review" message action — creates a pending record and posts it to a staff-only flag-queue channel. Nothing happens to the player yet.',
  },
  {
    title: '3. Review',
    body: 'A moderator opens "View context" to read the exact surrounding chat (live, or a stored snapshot if the messages are gone) and "Suspect history" for prior records — before deciding anything.',
  },
  {
    title: '4. Decide',
    body: 'The moderator picks Warn, Timeout, Mute, Kick, Ban, or Dismiss. The bot executes it through the moderation plugin — hierarchy checks, a case number, and a DM to the player — so staff never have to confront anyone directly.',
  },
  {
    title: '5. Ledger',
    body: 'Every flag and every decision is written to a read-only ledger channel and the database: record number, user, time, action, who decided, and the policy matched. Staff-only by default, optionally server-wide for transparency.',
  },
  {
    title: '6. Appeal',
    body: "The player can appeal directly with `/enforcer appeal <record #>`. The appeal opens through the moderation plugin's workflow and both the opening and the decision are written to the ledger too.",
  },
];

export const enforcerPrivacyPoints: string[] = [
  'Automatic flagging requires the Message Content privileged intent; without it, Enforcer runs in manual-flag-only mode and still works.',
  'Context snapshots (the messages around a flag) are stored only because this feature needs them to be reviewable later — that is disclosed in `/plugin status`, the dashboard, and the plugin README.',
  'A server can turn context capture off entirely; the ledger then keeps a jump link instead of an excerpt.',
  'Optional AI risk scoring is labelled assistive-only on every flag it touches — it explains, it never decides, and it never acts.',
  'Two moderators can never act on the same flag twice; a decision locks the record the instant the first moderator responds.',
];

export interface FaqEntry {
  question: string;
  answer: string;
}

export const enforcerFaq: FaqEntry[] = [
  {
    question: 'Does Enforcer replace the moderation plugin?',
    answer:
      'No — Enforcer is built on top of it. Every decision Enforcer executes (warn, timeout, kick, ban) is a real moderation case, with the same hierarchy checks, DM notice, and appeal workflow the moderation plugin already provides.',
  },
  {
    question: 'What happens without the Message Content intent?',
    answer:
      'Automatic flagging needs it to read message text. Without it, Enforcer still works in manual mode: staff can flag any message with the "Flag for review" action, or flag a user directly with `/enforcer flag`.',
  },
  {
    question: 'Can a moderator DM the flagged player directly?',
    answer:
      'That is exactly what Enforcer is designed to avoid. The bot is the only one that contacts the player — with the case number, the record number, and instructions to appeal — so the interaction stays professional and consistent no matter which moderator is on duty.',
  },
  {
    question: 'Is the ledger really tamper-evident?',
    answer:
      'The ledger channel is configured so only the bot can post in it — permission overwrites deny everyone else send access. The database record is the source of truth and every entry keeps its record number, so a gap or edit is visible.',
  },
  {
    question: 'What does the AI assist feature actually decide?',
    answer:
      'Nothing. When enabled, it adds a risk score and a plain-language explanation to a flag, clearly labelled "assistive — not a decision". A human moderator still has to choose Warn, Timeout, Mute, Kick, Ban, or Dismiss.',
  },
];
