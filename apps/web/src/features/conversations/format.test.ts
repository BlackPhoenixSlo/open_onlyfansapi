import type { StatsFan, StatsMessage } from '@api/contracts';
import { describe, expect, it } from 'vitest';
import { byDay, fanName, isHiddenMass, matchesFan, messageBadges, noTextLabel } from './format';

const msg = (over: Partial<StatsMessage> = {}): StatsMessage => ({
  accountId: 1,
  chatId: 2,
  fanUsername: 'fan_a',
  messageId: 1,
  createdAt: '2026-09-01T10:00:00.000Z',
  direction: 'inbound',
  text: 'hi',
  priceCents: 0,
  isFree: true,
  isOpened: false,
  isTip: false,
  tipCents: 0,
  mediaCount: 0,
  photos: 0,
  videos: 0,
  gifs: 0,
  audios: 0,
  hasPreview: false,
  isMass: false,
  isAutomated: false,
  automatedReason: null,
  isReply: false,
  isLiked: false,
  deletedAt: null,
  ...over,
});

const fan = (fanUsername: string | null, chatId: number) => ({ fanUsername, chatId }) as StatsFan;

describe('conversation format', () => {
  it('names and filters fans by username or chat id', () => {
    expect([fanName(fan('Ann', 7)), fanName(fan(null, 7))]).toEqual(['@Ann', 'chat 7']);
    expect(matchesFan(fan('Ann_B', 123), '@ann')).toBe(true);
    expect(matchesFan(fan(null, 123), '12')).toBe(true);
    expect(matchesFan(fan(null, 123), 'ann')).toBe(false);
    expect(matchesFan(fan(null, 123), ' ')).toBe(true);
  });

  it('labels a message without text by why', () => {
    expect(noTextLabel(msg({ text: '', mediaCount: 1, photos: 1 }))).toBe('No text: media only');
    expect(noTextLabel(msg({ text: '', gifs: 1 }))).toBe('No text: media only');
    expect(noTextLabel(msg({ text: '', isTip: true, tipCents: 500 }))).toBe('No text: tip only');
    expect(noTextLabel(msg({ text: '' }))).toBe('No text in this message');
  });

  it('badges PPV, tip, media, mass, automated and unsent', () => {
    const labels = (m: StatsMessage) => messageBadges(m).map((b) => b.label);
    expect(labels(msg())).toEqual([]);
    expect(labels(msg({ priceCents: 1250, isOpened: true, mediaCount: 3, photos: 1, videos: 2 }))).toEqual(['PPV $12.50 · opened', '1 photo · 2 videos']);
    expect(labels(msg({ priceCents: 300, mediaCount: 2 }))).toEqual(['PPV $3.00 · unopened', '2 media']);
    expect(labels(msg({ isTip: true, tipCents: 500 }))).toEqual(['Tip $5.00']);
    expect(labels(msg({ isMass: true, isAutomated: true, automatedReason: 'welcome', deletedAt: '2026-09-02T00:00:00.000Z' }))).toEqual([
      'Mass',
      'Automated (welcome)',
      'Unsent',
    ]);
  });

  it('hides mass messages but those the fan bought', () => {
    expect(isHiddenMass(msg({ isMass: true }))).toBe(true);
    expect(isHiddenMass(msg({ isMass: true, priceCents: 1000 }))).toBe(true);
    expect(isHiddenMass(msg({ isMass: true, priceCents: 1000, isOpened: true }))).toBe(false);
    expect(isHiddenMass(msg({ priceCents: 1000 }))).toBe(false);
  });

  it('groups messages by their day in the stats timezone', () => {
    const items = [
      msg({ messageId: 1, createdAt: '2026-09-01T21:30:00.000Z' }),
      msg({ messageId: 2, createdAt: '2026-09-01T22:30:00.000Z' }), // 2026-09-02 00:30 in Berlin
      msg({ messageId: 3, createdAt: '2026-09-02T08:00:00.000Z' }),
    ];
    const days = (tz: string) => byDay(items, tz).map((g) => [g.day, g.items.map((m) => m.messageId)]);
    expect(days('UTC')).toEqual([
      ['2026-09-01', [1, 2]],
      ['2026-09-02', [3]],
    ]);
    expect(days('Europe/Berlin')).toEqual([
      ['2026-09-01', [1]],
      ['2026-09-02', [2, 3]],
    ]);
  });
});
