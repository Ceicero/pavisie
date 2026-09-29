import type { TwitchChatChannel } from '@pavisie/database';
import type { CreatorIdentityDto, CreatorTwitchChannelDto } from '@pavisie/types/creator';
import { CONNECTION_STATUS_MAP } from '../dto';
import type { CreatorSessionData } from './session';

/** The creator's public identity — never includes the csrf token (that is returned alongside, explicitly). */
export function toCreatorIdentityDto(session: CreatorSessionData): CreatorIdentityDto {
  return {
    platform: session.platform,
    platformUserId: session.platformUserId,
    login: session.login,
    displayName: session.displayName,
    avatarUrl: session.avatarUrl,
  };
}

export function toCreatorTwitchChannelDto(row: TwitchChatChannel): CreatorTwitchChannelDto {
  return {
    id: row.id,
    broadcasterLogin: row.broadcasterLogin,
    broadcasterUserId: row.broadcasterUserId,
    enabled: row.enabled,
    status: CONNECTION_STATUS_MAP[row.status],
    lastError: row.lastError,
    commandPrefix: row.commandPrefix,
    discordLinked: row.guildId !== null,
    createdAt: row.createdAt.toISOString(),
  };
}
