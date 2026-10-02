import type { Metadata } from 'next';
import { CreatorShell } from '@/components/creator/creator-shell';

export const metadata: Metadata = {
  title: 'Creator dashboard',
  description:
    'Use Pavisie on your stream. Sign in with Twitch to add a chat bot, channel-point rewards and your own viewer currency to your channel. No Discord server needed.',
};

export default function CreatorLayout({ children }: { children: React.ReactNode }) {
  return <CreatorShell>{children}</CreatorShell>;
}
