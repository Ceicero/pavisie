import type { Metadata } from 'next';
import { Section } from '../../../components/Section';
import { Glass } from '../../../components/Glass';
import { PublicLeaderboard } from '../../../components/leaderboard/public-leaderboard';
import { INVALID_GUILD_MESSAGE, isGuildSnowflake } from '../../../lib/public/leaderboard';

interface PageProps {
  params: Promise<{ guildId: string }>;
}

export const metadata: Metadata = {
  title: 'XP Leaderboard',
  description: 'Public XP leaderboard for a Discord server that has opted in.',
};

export default async function PublicLeaderboardPage({ params }: PageProps) {
  const { guildId } = await params;
  const valid = isGuildSnowflake(guildId);

  return (
    <Section
      headingLevel={1}
      title="XP Leaderboard"
      subtitle={valid ? guildId : undefined}
    >
      {valid ? (
        <PublicLeaderboard guildId={guildId} />
      ) : (
        <Glass className="p-6 sm:p-8">
          <p className="text-sm leading-relaxed text-grey-3">{INVALID_GUILD_MESSAGE}</p>
        </Glass>
      )}
    </Section>
  );
}
