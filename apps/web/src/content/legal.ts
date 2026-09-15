// Privacy Policy / Terms of Service templates (ARCHITECTURE.md §17, SPEC.md §M). These are TEMPLATES: the
// `/privacy` and `/terms` pages render this content with a visible banner saying so, because a generic policy is
// not a substitute for one an operator has actually reviewed for their deployment and jurisdiction.

export const DEFAULT_OPERATOR = 'Pavisie';
/**
 * Published contact address in the privacy policy, terms and security page. `contact@pavisie.com`
 * is the intended destination, but pavisie.com still publishes no MX records (checked
 * 2026-09-14), so mail sent there would bounce — and a privacy policy listing a bouncing address
 * is worse than an off-brand one that works. This deliberately stays on the monitored Gmail
 * inbox, which is unaffected by entrophybot.com being let go: the domain is going away, that
 * mailbox is not. Set NEXT_PUBLIC_CONTACT_EMAIL once pavisie.com can actually receive mail.
 */
export const DEFAULT_CONTACT_EMAIL =
  process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? 'entrophybot@gmail.com';

export interface LegalSection {
  title: string;
  paragraphs: string[];
}

export function privacyPolicy(operator: string, contactEmail: string): LegalSection[] {
  return [
    {
      title: '1. What this covers',
      paragraphs: [
        `This Privacy Policy explains what ${operator} collects when you use the Pavisie Discord bot, its dashboard, and this website, and why. It does not cover Discord itself — see Discord's own Privacy Policy for that.`,
      ],
    },
    {
      title: '2. Data collected by the bot',
      paragraphs: [
        'By default, Pavisie stores only what a feature needs to function: Discord IDs (server, user, channel, role, message) tied to the feature that used them — for example a moderation case, a ticket, or a level profile.',
        "Message content is never stored unless a specific feature explicitly requires it and a server administrator turns that feature on (for example, the Enforcer plugin's context capture, which can be disabled per server). Deleted-message and edited-message logging captures that an event happened, not the message text, unless a server enables content capture.",
        "Server administrators control which plugins are enabled and can review, export, or request deletion of their server's data at any time from the dashboard's privacy settings.",
      ],
    },
    {
      title: '3. Data collected by the dashboard',
      paragraphs: [
        "Signing into the dashboard uses Discord OAuth. We receive your Discord user id, username, avatar, and the list of servers you manage, only to determine which servers you're allowed to configure.",
        'A session cookie keeps you signed in; it is httpOnly, cannot be read by page scripts, and expires automatically. OAuth tokens are encrypted at rest and used only to call the Discord API on your behalf.',
      ],
    },
    {
      title: '4. Donations',
      paragraphs: [
        `Donations are handled entirely by Ko-fi. Clicking the donate link takes you to ${operator}'s Ko-fi page, where Ko-fi processes the payment and collects whatever information their service requires. ${operator}'s servers never receive any information about the donation or the donor — not a name, email, payment details, amount, or any other data. Ko-fi's own privacy policy governs what they collect and how they use it.`,
      ],
    },
    {
      title: '5. Cookies',
      paragraphs: [
        'This website does not use tracking or advertising cookies. The dashboard uses one strictly-necessary session cookie to keep you signed in.',
      ],
    },
    {
      title: '6. Data retention & deletion',
      paragraphs: [
        "Retention periods for moderation cases, logs, tickets, and Enforcer records are configurable per server, with sensible defaults. A server administrator can request an export or deletion of their server's data from the dashboard at any time; deletion removes the associated database records.",
      ],
    },
    {
      title: '7. Third parties',
      paragraphs: [
        `${operator} shares data only with the services required to operate the features you use — Discord (the platform itself), Ko-fi (donations only, and only what you send Ko-fi directly), and any optional integration a server administrator explicitly connects (for example Twitch, YouTube, Instagram, an AI provider for the AI assistant plugin, or a translation/weather provider for the utility plugin). No data is sold.`,
      ],
    },
    {
      title: '8. Your rights',
      paragraphs: [
        `Depending on your location, you may have rights to access, correct, or delete your data. Server administrators can act on Discord-server-scoped data directly from the dashboard; for anything else, contact ${contactEmail}.`,
      ],
    },
    {
      title: '9. Children',
      paragraphs: [
        `Pavisie runs on Discord, which requires users to be at least 13 years old under Discord's own Terms of Service. ${operator} does not knowingly collect data from anyone below that age, and relies on Discord's own age requirements rather than collecting separate age verification.`,
      ],
    },
    {
      title: '10. Changes to this policy',
      paragraphs: [
        'This policy may be updated as features change. Material changes will be reflected here with an updated effective date.',
      ],
    },
    {
      title: '11. Contact',
      paragraphs: [`Questions about this policy: ${contactEmail}.`],
    },
  ];
}

export function termsOfService(operator: string, contactEmail: string): LegalSection[] {
  return [
    {
      title: '1. Acceptance',
      paragraphs: [
        `By inviting the Pavisie bot to a Discord server, using its dashboard, or using this website, you agree to these Terms and to Discord's own Terms of Service and Community Guidelines.`,
      ],
    },
    {
      title: '2. The service',
      paragraphs: [
        `${operator} provides Pavisie, a modular Discord bot (moderation, automod, tickets, roles, leveling, and other optional plugins) and its companion dashboard and website, provided "as is" without warranty of any kind. Features may be added, changed, or removed at any time.`,
      ],
    },
    {
      title: '3. Acceptable use',
      paragraphs: [
        "You may not use Pavisie to violate Discord's Terms of Service or Developer Policy, to harass or dox others, to evade a ban or moderation action, to spam, or for any unlawful purpose. Server administrators are responsible for how they configure moderation and automation features on their own server.",
      ],
    },
    {
      title: '4. No wagering, no real-money economy',
      paragraphs: [
        'The optional economy plugin is a virtual-currency feature only. It has no real-money value, cannot be purchased, cashed out, or wagered, and is not gambling.',
      ],
    },
    {
      title: '5. Donations',
      paragraphs: [
        'Donations made through the Donate page are voluntary, one-time, and non-refundable. They fund hosting and development, grant no in-game advantage, special role, or other perk, and are not a purchase of goods or services. Donations are not tax-deductible unless explicitly stated otherwise at the time of donation.',
      ],
    },
    {
      title: '6. Moderation actions',
      paragraphs: [
        "Moderation decisions (warnings, timeouts, kicks, bans) are made and executed by the server's own moderators using the bot as a tool. " +
          `${operator} does not review or arbitrate individual server moderation decisions.`,
      ],
    },
    {
      title: '7. Availability',
      paragraphs: [
        'The service is provided on a best-effort basis with no uptime guarantee. Scheduled or emergency maintenance may cause temporary downtime.',
      ],
    },
    {
      title: '8. Termination',
      paragraphs: [
        `${operator} may suspend or terminate access to the service for any account or server that violates these Terms, Discord's policies, or applicable law.`,
      ],
    },
    {
      title: '9. Limitation of liability',
      paragraphs: [
        `To the maximum extent permitted by law, ${operator} is not liable for indirect, incidental, or consequential damages arising from use of the service.`,
      ],
    },
    {
      title: '10. Changes to these terms',
      paragraphs: [
        'These Terms may be updated as the service changes. Continued use after a change constitutes acceptance of the update.',
      ],
    },
    {
      title: '11. Contact',
      paragraphs: [`Questions about these Terms: ${contactEmail}.`],
    },
  ];
}
