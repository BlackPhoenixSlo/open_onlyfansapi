import type { StatsMessage } from '@api/contracts';
import { describe, expect, it } from 'vitest';
import { byDay, fanFileName, fanName, isHiddenMass, messageBadges, noTextLabel } from './format';

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

describe('conversation format', () => {
  it('names a fan by username, else name, else chat id, for display and for file names', () => {
    expect([fanName({ fanUsername: 'Ann', chatId: 7 }), fanName({ fanUsername: null, chatId: 7 }), fanName({ name: 'Ann B', chatId: 7 })]).toEqual([
      '@Ann',
      'chat 7',
      'Ann B',
    ]);
    expect([fanFileName({ fanUsername: 'Ann', chatId: 7 }), fanFileName({ fanUsername: null, chatId: 7 })]).toEqual(['Ann', 'chat-7']);
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
    expect(labels(msg({ priceCents: 1250, isOpened: true, mediaCount: 3, photos: 1, videos: 2 }))).toEqual(['PPV $12.50 · bought', '1 photo · 2 videos']);
    expect(labels(msg({ priceCents: 300, mediaCount: 2 }))).toEqual(['PPV $3.00 · not bought', '2 media']);
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
