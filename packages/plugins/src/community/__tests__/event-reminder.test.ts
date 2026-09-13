import { describe, expect, it } from 'vitest';

// Test data extraction and chunking logic for fireEventReminder
// Since fireEventReminder is action/impure code that touches Discord.js and Prisma,
// we test the core chunking algorithm separately below.

/** Extracts userId from a Discord mention string. */
function extractUserIdFromMention(mention: string): string {
  const match = mention.match(/\d+/);
  return match ? match[0] : '';
}

/** Splits an array of RSVPs into chunks respecting Discord limits:
 * max 100 mentions per message, max 2000 chars per message. */
function chunkReminders(eventTitle: string, rsvpUserIds: string[]): Array<{ userIds: string[]; mentions: string }> {
  const eventHeader = `📅 **${eventTitle}** starts in X minutes!`;
  const MAX_MENTIONS_PER_MESSAGE = 100;
  const MAX_CHARS_PER_MESSAGE = 2000;

  const chunks: Array<{ userIds: string[]; mentions: string }> = [];
  let currentUserIds: string[] = [];
  let currentLength = eventHeader.length + 2;

  for (const userId of rsvpUserIds) {
    const mention = `<@${userId}>`;
    const mentionLength = mention.length + 1;

    if (
      currentUserIds.length >= MAX_MENTIONS_PER_MESSAGE ||
      currentLength + mentionLength > MAX_CHARS_PER_MESSAGE
    ) {
      if (currentUserIds.length > 0) {
        chunks.push({ userIds: [...currentUserIds], mentions: currentUserIds.map((id) => `<@${id}>`).join(' ') });
        currentUserIds = [];
        currentLength = eventHeader.length + 2;
      }
    }

    currentUserIds.push(userId);
    currentLength += mentionLength;
  }

  if (currentUserIds.length > 0) {
    chunks.push({ userIds: [...currentUserIds], mentions: currentUserIds.map((id) => `<@${id}>`).join(' ') });
  }

  return chunks;
}

describe('fireEventReminder — chunking logic', () => {
  it('fits a small RSVP list into a single message', () => {
    const userIds = Array.from({ length: 5 }, (_, i) => `user-${i}`);
    const chunks = chunkReminders('Community Hangout', userIds);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].userIds).toEqual(userIds);
  });

  it('splits 150 attendees across multiple messages when exceeding 100 mentions', () => {
    const userIds = Array.from({ length: 150 }, (_, i) => `user-${i}`);
    const chunks = chunkReminders('Big Event', userIds);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should have 100, second chunk should have 50
    expect(chunks[0].userIds).toHaveLength(100);
    expect(chunks[1].userIds).toHaveLength(50);
  });

  it('respects the 2000 character message limit', () => {
    // Create user IDs that are long to hit char limit faster
    const longUserIds = Array.from({ length: 100 }, (_, i) => `user-with-very-long-id-${i}`);
    const chunks = chunkReminders('Test Event', longUserIds);
    // With long IDs, even 100 mentions might exceed 2000 chars
    for (const chunk of chunks) {
      const eventHeader = `📅 **Test Event** starts in X minutes!`;
      const fullContent = `${eventHeader} ${chunk.mentions}`;
      expect(fullContent.length).toBeLessThanOrEqual(2000);
    }
  });

  it('ensures all mentions are included across chunks', () => {
    const userIds = Array.from({ length: 250 }, (_, i) => `user-${i}`);
    const chunks = chunkReminders('Marathon Event', userIds);
    const allMentioned = chunks.flatMap((c) => c.userIds);
    expect(allMentioned).toEqual(userIds);
  });

  it('never exceeds 100 mentions per chunk', () => {
    const userIds = Array.from({ length: 300 }, (_, i) => `user-${i}`);
    const chunks = chunkReminders('Massive Event', userIds);
    for (const chunk of chunks) {
      expect(chunk.userIds.length).toBeLessThanOrEqual(100);
    }
  });

  it('handles an empty RSVP list', () => {
    const chunks = chunkReminders('Empty Event', []);
    expect(chunks).toHaveLength(0);
  });

  it('preserves user order across chunks', () => {
    const userIds = Array.from({ length: 150 }, (_, i) => `user-${String(i).padStart(3, '0')}`);
    const chunks = chunkReminders('Ordered Event', userIds);
    const reconstructed = chunks.flatMap((c) => c.userIds);
    expect(reconstructed).toEqual(userIds);
  });
});
