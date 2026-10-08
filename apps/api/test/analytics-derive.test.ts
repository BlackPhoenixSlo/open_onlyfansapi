import { describe, expect, it } from 'vitest';
import { retryDelay } from '../src/modules/analytics/backfill.js';
import { REPLY_CAP_MS } from '../src/modules/analytics/config.js';
import {
  deriveContext,
  deriveMessage,
  fanNames,
  isScriptEligible,
  NORMALISER_VERSION,
  normaliseScript,
  normaliseText,
  plainText,
  scriptHash,
  textHash,
  txFan,
} from '../src/modules/analytics/derive.js';
import { isScript, SCRIPT_WINDOW_MS } from '../src/modules/analytics/scripts.js';
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

describe('plain text', () => {
  it('strips inline tags to nothing, so a word split by <b> stays one word', () => {
    expect(plainText('lo<b>ve</b> <i>you</i> <strong>so</strong> <em>much</em> <a href="x">ok</a><span>!</span> <u>u</u><s>s</s>')).toBe('love you so much ok! us');
  });

  it('turns block and break tags into one space', () => {
    expect(plainText('<p>one</p><p>two</p>three<br>four<br />five<div>six</div><ul><li>a</li><li>b</li></ul><h2>T</h2>')).toBe('one two three four five six a b T');
  });

  it('reads a > inside a quoted attribute value as part of the tag', () => {
    expect(plainText(`<p title="1 > 0">Hi</p><span data-x='a>b'>there</span>`)).toBe('Hi there');
  });

  it('decodes numeric and the common named entities, keeps case, and leaves a literal <3', () => {
    expect(plainText('It&#39;s &#x27;Ok&#X27; &amp; &lt;3 &gt; &quot;x&quot; &apos;y&apos;&nbsp;Z &copy;')).toBe(`It's 'Ok' & <3 > "x" 'y' Z &copy;`);
  });
});

describe('script normaliser (§4.4)', () => {
  const LINE = 'I made something special for you';

  it('is version 1', () => {
    expect(NORMALISER_VERSION).toBe(1);
  });

  it('applies each text rule: tags, HTML entities, NFKC, lowercase, whitespace', () => {
    expect(normaliseScript('<p>a</p><p>b</p>')).toBe('a b'); // a tag becomes a space
    expect(normaliseScript('Tom &amp; Jerry &lt;3 &#x1F600; &quot;hi&quot;')).toBe('tom & jerry <3 😀 "hi"');
    expect(normaliseScript('ｆｕｌｌ ①')).toBe('full 1'); // NFKC
    expect(normaliseScript('HeLLo')).toBe('hello');
    expect(normaliseScript('  a \n\t b  ')).toBe('a b');
    expect(normaliseScript('$9.99 for 2 🔥!!')).toBe('$9.99 for 2 🔥!!'); // numbers, prices, emoji, punctuation stay
  });

  it("replaces the fan's name, username and custom name with <name>, whole words only, longest first", () => {
    const names = fanNames({ name: 'Anna', username: 'anna_b', displayName: 'Anna Banana', id: 7 });
    expect(names).toEqual(['Anna', 'anna_b', 'Anna Banana']);
    expect(normaliseScript('<p>Hey ANNA, hi @anna_b and Anna Banana</p>', names)).toBe('hey <name>, hi @<name> and <name>');
    expect(normaliseScript('Hey Annabel', names)).toBe('hey annabel'); // not inside a word
    expect(normaliseScript('Hey Name, hey a', ['name', 'a'])).toBe('hey <name>, hey a'); // one pass; a 1-character name is ignored
    expect(fanNames({ name: '', username: null })).toEqual([]);
    expect(fanNames(undefined)).toEqual([]);
  });

  it('is eligible with 4+ words or 20+ characters, else no hash', () => {
    expect(isScriptEligible('one two three four')).toBe(true);
    expect(isScriptEligible('one two three')).toBe(false);
    expect(isScriptEligible('abcdefghijklmnopqrst')).toBe(true); // 20 characters, one word
    expect(isScriptEligible('abcdefghijklmnopqrs')).toBe(false);
    expect(scriptHash('<p>hey</p>')).toBeNull();
    expect(scriptHash('')).toBeNull();
    expect(scriptHash(undefined)).toBeNull();
    expect(scriptHash('<p>Hey Bo</p>', ['Bo'])).toBeNull(); // "hey <name>": 2 words, 10 characters
  });

  it('hashes the normalised text to 16 hex: personalised sends of one script share a hash', () => {
    const anna = scriptHash(`<p>Hey Anna, ${LINE}</p>`, ['Anna']);
    expect(anna).toMatch(/^[0-9a-f]{16}$/);
    expect(scriptHash(`Hey   BOB, ${LINE}`, ['Bob'])).toBe(anna);
    expect(scriptHash(`<p>Hey Anna, ${LINE}</p>`)).not.toBe(anna); // without the name it stays literal
    expect(scriptHash(`<p>Hey Anna, ${LINE}!</p>`, ['Anna'])).not.toBe(anna);
  });
});

describe('script detection (§2)', () => {
  const at = (day: number) => new Date(Date.UTC(2026, 8, 1) + day * 86_400_000);
  const sends = (list: [number, number][]) => list.map(([day, chatId]) => ({ at: at(day), chatId }));

  it('needs 5+ sends in 3+ chats within 30 days', () => {
    expect(isScript(sends([[0, 1], [1, 1], [2, 2], [3, 2], [4, 3]]))).toBe(true);
    expect(isScript(sends([[0, 1], [1, 1], [2, 2], [3, 2], [4, 2]]))).toBe(false); // 2 chats
    expect(isScript(sends([[0, 1], [1, 2], [2, 3], [3, 3]]))).toBe(false); // 4 sends
    expect(isScript(sends([[0, 1], [10, 2], [20, 3], [30, 1], [31, 2]]))).toBe(false); // never 5 within 30 days
    expect(isScript(sends([[0, 1], [10, 2], [20, 3], [29, 1], [30, 2]]))).toBe(true); // exactly 30 days
    expect(SCRIPT_WINDOW_MS).toBe(30 * 86_400_000);
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
    expect(inbound!.normaliserVersion).toBeNull();
    const text = '<p>Hey Anna, how was your day?</p>';
    expect(deriveMessage(msg({ text }), 2001, ctx)).toMatchObject({ direction: 'outbound', textHash: scriptHash(text), normaliserVersion: 1 });
    expect(deriveMessage(msg({ text: 'hello' }), 2001, ctx)).toMatchObject({ direction: 'outbound', textHash: null, normaliserVersion: 1 });
  });

  it("hashes with the fan's names from the chat list and from the message's fan user", () => {
    const withName = scriptHash('<p>Hey <name>, how was your day?</p>'.replace('<name>', 'Anna'), ['Anna']);
    expect(deriveMessage(msg({ text: '<p>Hey Anna, how was your day?</p>' }), 2001, ctx, ['Anna'])!.textHash).toBe(withName);
    const toUser = { id: 2001, name: 'Anna' };
    expect(deriveMessage(msg({ text: '<p>Hey Anna, how was your day?</p>', toUser }), 2001, ctx)!.textHash).toBe(withName);
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
    expect(turns).toMatchObject([
      { chatId: 1, inboundAt: new Date(t0), lastInboundAt: new Date(t0 + H), dmAt: new Date(t0 + 4 * H), waitSeconds: 4 * 3600, status: 'in_cap', isAutomated: true },
      { chatId: 1, inboundAt: new Date(t0 + 6 * H), lastInboundAt: new Date(t0 + 6 * H), dmAt: new Date(t0 + 20 * H), waitSeconds: 14 * 3600, status: 'late', isAutomated: false },
    ]);
    expect(turns).toHaveLength(2);
  });

  it('takes the reply cap from the options; a DM shorter than minReplyChars does not end a substantive turn', () => {
    const msgs = [m(3, 0, 'inbound'), m(3, 1, 'outbound', { textChars: 7 }), m(3, 3, 'outbound', { textChars: 30 })];
    const asOf = new Date(t0 + 100 * H);
    expect(fanTurns(msgs, { asOf, replyCapMs: 2 * H }).map((t) => [t.waitSeconds, t.status])).toEqual([[3600, 'in_cap']]);
    expect(fanTurns(msgs, { asOf, replyCapMs: 2 * H, minReplyChars: 15 }).map((t) => [t.waitSeconds, t.status])).toEqual([[3 * 3600, 'late']]);
  });

  it('orders by (createdAt, id) and leaves an open turn pending until the cap elapses', () => {
    const a = m(2, 1, 'outbound');
    const b = m(2, 1, 'inbound'); // same time, larger id: after the DM
    const turns = fanTurns([b, a], { asOf: new Date(t0 + H + REPLY_CAP_MS) });
    expect(turns).toMatchObject([{ chatId: 2, inboundAt: new Date(t0 + H), dmAt: null, dmMessageId: null, waitSeconds: null, status: 'pending', isAutomated: false }]);
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
