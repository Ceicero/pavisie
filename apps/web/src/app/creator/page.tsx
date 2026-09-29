import { CreatorDashboard } from '@/components/creator/creator-dashboard';

/** `/creator` — the creator dashboard: a streamer signs in with their streaming-platform account (Twitch today)
 * and manages Pavisie for their channel, with no Discord server involved (docs/ARCHITECTURE.md section 19e). */
export default function CreatorPage() {
  return <CreatorDashboard />;
}
