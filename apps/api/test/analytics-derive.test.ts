import { describe, expect, it } from 'vitest';
import { retryDelay } from '../src/modules/analytics/backfill.js';
import { REPLY_CAP_MS } from '../src/modules/analytics/config.js';
import { deriveContext, deriveMessage, normaliseText, textHash, txFan } from '../src/modules/analytics/derive.js';
import { fanTurns, type TurnMessage } from '../src/modules/analytics/turns.js';

const ACCOUNT = 1001;

describe('analytics normaliser', () => {
  it('strips tags, unescapes HTML, NFKC, lowercases and collapses whitespace', () => {
    expect(normaliseText('<p>Hey&nbsp;YOU</p><p>&amp;  ﬁne &lt;3 &#128512;</p><br />')).toBe('hey you & fine <3 😀');
  });

  it('hashes to 16 hex; empty text has no hash; same normalised text, same hash', () => {
    expect(textHash('<p>Hi there</p>')).toMatch(/^[0-9a-f]{16}$/);
    expect(textHash('<p>Hi there</p>')).toBe(textHash('hi   THERE'));
    expect(textHash('<p> </p>')).toBeNull();
    expect(textHash(undefined)).toBeNull();
  });
});

describe('analytics derived columns', () => {
  const ctx = deriveContext(
    ACCOUNT,
    [
      { id: 900, sentCount: 250 },
      { id: 901, sentCount: 1 },
    ],
    { text: '<p>Welcome!</p>', media: [{ id: 7 }, { id: 3 }] },
    ['brb babe'],
  );
  const msg = (over: Record<string, unknown>) => ({ id: 1, createdAt: '2026-09-01T10:00:00.000Z', fromUser: { id: ACCOUNT }, text: '', ...over });

  it('splits direction on fromUser.id and hashes outbound text only', () => {
    const inbound = deriveMessage(msg({ fromUser: { id: 2001 }, text: 'hello' }), 2001, ctx);
    expect(inbound).toMatchObject({ direction: 'inbound', textHash: null, isMass: false, isAutomated: false });
    expect(deriveMessage(msg({ text: 'hello' }), 2001, ctx)).toMatchObject({ direction: 'outbound', textHash: textHash('hello') });
  });

  it('is mass only when the queue id is a broadcast with sentCount > 1', () => {
    expect(deriveMessage(msg({ queueId: 900, isFromQueue: true }), 2001, ctx)).toMatchObject({ isMass: true, queueId: 900 });
    expect(deriveMessage(msg({ queueId: 901, isFromQueue: true }), 2001, ctx)).toMatchObject({ isMass: false, queueId: 901 });
    expect(deriveMessage(msg({ queueId: 902 }), 2001, ctx)!.isMass).toBe(false);
  });

  it('derives nothing from a message without a numeric id', () => {
    expect(deriveMessage(msg({ id: null }), 2001, ctx)).toBeNull();
    expect(deriveMessage(msg({ id: 'x' }), 2001, ctx)).toBeNull();
    expect(deriveMessage(msg({ id: '42' }), 2001, ctx)!.messageId).toBe(42);
  });

  it('marks welcome by text or media and automation by text', () => {
    expect(deriveMessage(msg({ text: 'WELCOME!' }), 2001, ctx)).toMatchObject({ isAutomated: true, automatedReason: 'welcome' });
    expect(deriveMessage(msg({ media: [{ id: 3 }, { id: 7 }] }), 2001, ctx)).toMatchObject({ automatedReason: 'welcome', mediaKey: '3,7' });
    expect(deriveMessage(msg({ text: '<p>BRB babe</p>' }), 2001, ctx)).toMatchObject({ automatedReason: 'automation' });
    expect(deriveMessage(msg({ fromUser: { id: 2001 }, text: 'welcome!' }), 2001, ctx)!.isAutomated).toBe(false);
  });

  it('reads price, tip and media', () => {
    const d = deriveMessage(msg({ price: 19.99, isTip: true, mediaCount: 2, media: [{ id: 20 }, { id: 3 }] }), 2001, ctx);
    expect(d).toMatchObject({ priceCents: 1999, isTip: true, mediaCount: 2, mediaKey: '3,20' });
  });

  it('takes the transaction fan from user.id, else a numeric profile link in the description', () => {
    expect(txFan({ user: { id: 2001 }, description: 'x' })).toEqual({ fanId: 2001, fanIdSource: 'field' });
    expect(txFan({ description: 'Tip from <a href="https://onlyfans.com/u2003">u2003</a>' })).toEqual({ fanId: 2003, fanIdSource: 'description' });
    expect(txFan({ description: 'Tip from <a href="https://onlyfans.com/somefan">x</a>' })).toEqual({ fanId: null, fanIdSource: null });
    expect(txFan({ description: 'Tip from <a href="https://onlyfans.com/u2003x">x</a>' })).toEqual({ fanId: null, fanIdSource: null });
  });
});

describe('analytics fan turns', () => {
  const H = 3_600_000;
  const t0 = Date.parse('2026-09-01T00:00:00.000Z');
  let id = 0;
  const m = (chatId: number, hours: number, direction: 'inbound' | 'outbound', over: Partial<TurnMessage> = {}): TurnMessage => ({
    chatId,
    messageId: ++id,
    createdAt: new Date(t0 + hours * H),
    direction,
    isMass: false,
    isAutomated: false,
    ...over,
  });

  it('runs from the first inbound after a DM to the next DM; mass and automated do not end it', () => {
    const turns = fanTurns(
      [
        m(1, 0, 'inbound'),
        m(1, 1, 'inbound'), // same turn
        m(1, 2, 'outbound', { isMass: true }),
        m(1, 3, 'outbound', { isAutomated: true }),
        m(1, 4, 'outbound'), // the reply
        m(1, 5, 'outbound'), // no turn open
        m(1, 6, 'inbound'),
        m(1, 20, 'outbound'), // late: past the 12 h cap
      ],
      { asOf: new Date(t0 + 100 * H) },
    );
    expect(turns).toEqual([
      { chatId: 1, inboundAt: new Date(t0), dmAt: new Date(t0 + 4 * H), waitSeconds: 4 * 3600, status: 'in_cap', isAutomated: true },
      { chatId: 1, inboundAt: new Date(t0 + 6 * H), dmAt: new Date(t0 + 20 * H), waitSeconds: 14 * 3600, status: 'late', isAutomated: false },
    ]);
  });

  it('orders by (createdAt, id) and leaves an open turn pending until the cap elapses', () => {
    const a = m(2, 1, 'outbound');
    const b = m(2, 1, 'inbound'); // same time, larger id: after the DM
    const turns = fanTurns([b, a], { asOf: new Date(t0 + H + REPLY_CAP_MS) });
    expect(turns).toEqual([{ chatId: 2, inboundAt: new Date(t0 + H), dmAt: null, waitSeconds: null, status: 'pending', isAutomated: false }]);
    expect(fanTurns([b, a], { asOf: new Date(t0 + H + REPLY_CAP_MS + 1) })[0]!.status).toBe('breached');
  });
});

describe('analytics 429 backoff', () => {
  const cfg = { backoffBaseMs: 1000, backoffMaxMs: 60_000 };
  it('respects Retry-After (seconds or a date), else doubles, always capped', () => {
    expect(retryDelay('42', 0, cfg)).toBe(42_000);
    expect(retryDelay('9999', 0, cfg)).toBe(60_000);
    expect(retryDelay(new Date(Date.now() + 5000).toUTCString(), 0, cfg)).toBeGreaterThan(3000);
    expect([0, 1, 3].map((a) => retryDelay(null, a, cfg))).toEqual([1000, 2000, 8000]);
    expect(retryDelay(null, 10, cfg)).toBe(60_000);
    expect(retryDelay('soon', 1, cfg)).toBe(2000);
  });
});
