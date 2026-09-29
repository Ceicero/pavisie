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
        "When a streamer turns on the Discord ↔ Twitch chat bridge (from the creator dashboard, for a Discord server they connected there), chat messages (text and display name) posted in the bridged Discord channel and/or the linked Twitch chat are shown on the other platform for as long as that direction stays on. Pavisie does not store or log that text. Once a message is relayed, it becomes an ordinary message on the destination platform and is stored there under that platform's own terms — deleting the original does not delete the relayed copy.",
        "When a streamer turns on their channel's virtual currency (Agis by default) — from the creator dashboard, with or without a Discord server linked — Pavisie stores a Twitch wallet held per Twitch channel: the Twitch user id, display name, balance, and an append-only transaction history, for each Twitch viewer who runs a currency chat command (balance/daily/give/top), earns currency by chatting, or receives currency from another viewer via give. These wallets exist whether or not a Discord server is linked to the channel; a linked server can only show their leaderboard. The streamer can also add to or remove from a viewer's balance, and the change is recorded with the reason they enter. Balances of the currency that used to belong to a Discord server's Twitch chat setup were copied to the channel's own currency when this changed; the old copies are kept for now and then deleted. Twitch chat message text itself is still never stored or logged.",
        "The Pavisie Twitch Extension (a panel shown under a streamer's video) shows a viewer's wallet balance in that channel's currency and lets them claim the daily reward, the same way the chat commands do. It uses the viewer's real Twitch user id only if the viewer chooses to share their identity with the extension (a one-time prompt Twitch itself shows); until then, the panel works with no viewer-identifying data at all beyond Twitch's own pseudonymous per-viewer id, which is only held briefly for rate limiting and never saved to Pavisie's database. No chat text is read, sent, or stored by the extension — it only calls the same read/claim API the chat commands use.",
      ],
    },
    {
      title: '3. Data collected by the dashboard',
      paragraphs: [
        "Signing into the dashboard uses Discord OAuth. We receive your Discord user id, username, avatar, and the list of servers you manage, only to determine which servers you're allowed to configure.",
        'A session cookie keeps you signed in; it is httpOnly, cannot be read by page scripts, and expires automatically. OAuth tokens are encrypted at rest and used only to call the Discord API on your behalf.',
        "Streamers can also use the creator dashboard (/creator) with just a Twitch account, no Discord account or server needed. Signing in there asks Twitch only who you are: we receive your Twitch user id, login name, display name and profile picture address, and hold them in a session for up to 7 days (renewed while you keep using it) so the page can show you as signed in. The Twitch sign-in token is used once to ask Twitch who you are and is not stored; we also ask Twitch to revoke it. Signing out ends the session immediately.",
        "If you connect Pavisie's chat bot to your Twitch channel from the creator dashboard, we store your Twitch channel id and login name together with the commands, timers and settings you create there, until you disconnect. Disconnecting deletes them, unless the channel is also linked to a Discord server, in which case that server's own settings are kept and the bot is only switched off. Twitch chat message text is never stored or logged.",
        "If you set up a viewer currency for your channel on the creator dashboard, we store its settings (name, symbol, reward amounts, earning rules) against your Twitch channel id, together with your viewers' wallets described above. It is kept independently of the chat bot connection: disconnecting the bot does not delete it, so viewers keep their balances if you reconnect.",
        "If you turn on channel-point rewards from the creator dashboard, Twitch asks you to approve one permission: seeing which channel-point rewards your viewers redeem. Pavisie keeps that permission (a token) encrypted against your Twitch channel until you disconnect channel points from the dashboard or delete the channel, and uses it only to receive redemptions of your own rewards. We also store the rewards you set up (title, action, sound link, message template, cooldown) and your OBS overlay link (encrypted). If you want rewards read aloud you can add your own OpenAI API key: it is stored encrypted, is never shown again, and is used only to turn your text-to-speech rewards into speech, which means the text being spoken is sent to OpenAI (you pay OpenAI directly). What a viewer types when redeeming a reward is used in memory only to run the reward and is never stored or logged by Pavisie.",
        "If you connect a Discord server from the creator dashboard (optional), you sign into Discord once. Pavisie reads your Discord user id and the list of servers you are in a single time, only to show you which ones you can manage that Pavisie is also in, and holds that short list for a few minutes so you can pick one. Your Discord sign-in token is used for those two reads, is not stored, and we ask Discord to revoke it. What we keep is the link itself: which server your channel is connected to, your Discord user id and the date (an audit record, also shown in that server's audit log), and the bridge settings you choose. If you turn the chat bridge on, text posted in the chosen Discord channel is shown in your Twitch chat and vice versa; it is relayed in memory and never stored or logged by Pavisie. Disconnecting the server switches the bridge off and removes rewards that post to Discord.",
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
        'This website does not use tracking or advertising cookies. The dashboard uses one strictly-necessary session cookie to keep you signed in. The creator dashboard uses its own strictly-necessary session cookie, plus a short-lived one (a few minutes) during Twitch sign-in, and again when you connect a Discord server, that makes sure the sign-in finishes in the browser that started it.',
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
