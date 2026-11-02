/**
 * The starter pack's report text is written for a Discord embed (the bot localizes it once and both the command
 * and the dashboard show it). The dashboard has no markdown renderer for that text, so this reduces it to plain
 * text: Discord bold/italic/code markers are dropped and `<#channelId>` mentions become "#channel".
 */
export function plainDiscordText(text: string): string {
  return text
    .replace(/<#\d+>/g, '#channel')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

/** True when the form can be submitted: a login needs a channel to post in; no login needs nothing. */
export function isStarterFormValid(twitchLogin: string, alertChannelId: string | null): boolean {
  return twitchLogin.trim() === '' || Boolean(alertChannelId);
}
