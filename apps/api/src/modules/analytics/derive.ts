import { createHash } from 'node:crypto';

// Columns derived from OF's raw objects (spec §2, §4.3). Pure: a definition change re-derives from `raw`.

export type Raw = Record<string, unknown>;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[e.toLowerCase()] ?? match;
  });
}

/**
 * The text part of the script normaliser (§4.4): strip tags (each becomes a space, so `<p>a</p><p>b</p>` stays two
 * words), unescape HTML, NFKC, lowercase, collapse whitespace. Tags go first so an escaped `&lt;3` survives.
 */
export function normaliseText(html: string): string {
  return unescapeHtml(html.replace(/<[^>]*>/g, ' '))
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** An HTML tag and its name; a `>` inside a quoted attribute value does not end it. */
const TAG = /<\/?([a-z][a-z0-9]*)(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const BLOCK_TAGS = new Set(['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * A message's text, verbatim but plain, for reading and export: a block or break tag becomes a space, any other tag
 * (`<b>`, `<a>`, `<span>`…) nothing, so `lo<b>ve</b>` stays one word; HTML unescaped, whitespace collapsed, case kept.
 */
export function plainText(html: string): string {
  return unescapeHtml(html.replace(TAG, (_tag, name: string) => (BLOCK_TAGS.has(name.toLowerCase()) ? ' ' : '')))
    .replace(/\s+/g, ' ')
    .trim();
}

const sha16 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** SHA-256 of the normalised text (no name replacement), first 16 hex; null when nothing is left. Matches welcome and automation texts. */
export function textHash(html: unknown): string | null {
  const text = typeof html === 'string' ? normaliseText(html) : '';
  return text ? sha16(text) : null;
}

/** Bumped whenever `normaliseScript` or script eligibility changes; stored beside every script hash. */
export const NORMALISER_VERSION = 1;

/** The fan's name, username and custom name (the account's nickname for the fan, OF's `displayName`) on a user object. */
export function fanNames(user: unknown): string[] {
  const u = user as Raw | null | undefined;
  return [u?.name, u?.username, u?.displayName].filter((n): n is string => typeof n === 'string' && n.trim() !== '');
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The script normaliser (§4.4), version 1: `normaliseText`, then each of the fan's names (normalised the same way,
 * 2+ characters, as a whole word, longest first, in one pass) becomes `<name>`. Numbers, emoji, prices and
 * punctuation stay.
 */
export function normaliseScript(html: string, names: string[] = []): string {
  const text = normaliseText(html);
  const forms = [...new Set(names.map(normaliseText))].filter((n) => [...n].length >= 2).sort((a, b) => b.length - a.length);
  if (!forms.length) return text;
  const word = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${forms.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  return text.replace(word, '<name>');
}

/** A script needs 4+ tokens or 20+ characters after normalising, so "hey" and empty captions don't collide. */
export const isScriptEligible = (normalised: string) => normalised.split(' ').filter(Boolean).length >= 4 || [...normalised].length >= 20;

/** The script hash (§4.4): SHA-256 of `normaliseScript`, first 16 hex; null when the text is not eligible. */
export function scriptHash(html: unknown, names: string[] = []): string | null {
  const text = typeof html === 'string' ? normaliseScript(html, names) : '';
  return isScriptEligible(text) ? sha16(text) : null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
/** A safe integer, or a string of one; else null (OF ids, live payload fields). */
export const int = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && Number.isSafeInteger(n) ? n : null;
};
const cents = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n * 100);
};

/** Sorted media ids, comma-joined; null = no media. */
export function mediaKey(media: unknown): string | null {
  if (!Array.isArray(media)) return null;
  const ids = media
    .map((m) => num((m as Raw | null)?.id))
    .filter((id): id is number => id !== null)
    .sort((a, b) => a - b);
  return ids.length ? ids.join(',') : null;
}

export type MessageDetail = {
  isFree: boolean;
  photos: number;
  videos: number;
  /** `media[].type` `gif`, plus 1 for a GIPHY gif (`giphyId`), which OF does not count in `mediaCount`. */
  gifs: number;
  audios: number;
  /** `previews` (the media ids shown free before purchase) is not empty. */
  hasPreview: boolean;
  /** The message replies to another (`replyToMessage`). */
  isReply: boolean;
  /** OF's `isLiked`: the other side liked it. */
  isLiked: boolean;
};

/** Per-message detail for the export, read from OF's raw message object; absent or malformed fields read as false / 0. */
export function messageDetail(raw: Raw): MessageDetail {
  const media = Array.isArray(raw.media) ? (raw.media as unknown[]) : [];
  const ofType = (type: string) => media.filter((m) => (m as Raw | null)?.type === type).length;
  return {
    isFree: raw.isFree === true,
    photos: ofType('photo'),
    videos: ofType('video'),
    gifs: ofType('gif') + (typeof raw.giphyId === 'string' && raw.giphyId !== '' ? 1 : 0),
    audios: ofType('audio'),
    hasPreview: Array.isArray(raw.previews) && raw.previews.length > 0,
    isReply: raw.replyToMessage !== null && typeof raw.replyToMessage === 'object',
    isLiked: raw.isLiked === true,
  };
}

export type DeriveContext = {
  accountId: number;
  /** Mass history: broadcast queue id → sentCount. */
  massSent: Map<number, number>;
  /** The OF welcome message (`reply_on_subscribe`), or null when none is set. */
  welcome: { textHash: string | null; mediaKey: string | null } | null;
  /** Hashes of the client's automation texts. */
  automationHashes: Set<string>;
};

export function deriveContext(
  accountId: number,
  massItems: Raw[],
  welcome: Raw | null,
  automationTexts: string[],
): DeriveContext {
  const massSent = new Map<number, number>();
  for (const item of massItems) {
    const id = num(item.id);
    if (id !== null) massSent.set(id, num(item.sentCount) ?? 0);
  }
  return {
    accountId,
    massSent,
    welcome: welcome ? { textHash: textHash(welcome.text), mediaKey: mediaKey(welcome.media) } : null,
    automationHashes: new Set(automationTexts.map(textHash).filter((h): h is string => h !== null)),
  };
}

export type DerivedMessage = {
  messageId: number;
  chatId: number;
  direction: 'inbound' | 'outbound';
  createdAt: Date;
  isMass: boolean;
  queueId: number | null;
  isAutomated: boolean;
  automatedReason: 'welcome' | 'automation' | null;
  priceCents: number;
  isTip: boolean;
  /** `tipAmount` in cents on a tip (`isTip`), else 0. */
  tipCents: number;
  /** OF's `isOpened`: on a priced message, the fan bought (unlocked) it. */
  isOpened: boolean;
  mediaCount: number;
  mediaKey: string | null;
  /** The script hash (outbound, eligible text only). */
  textHash: string | null;
  /** `NORMALISER_VERSION` on outbound rows; null on inbound. */
  normaliserVersion: number | null;
};

/**
 * Derived columns of one OF message in chat `chatId`; null when it has no numeric `id`. Outbound = `fromUser.id` is
 * the account. Mass = its `queueId` is a broadcast with `sentCount > 1` in the mass history; the backfill's store also
 * marks bulk sends mass (a queue id in 8+ chats, backfill.ts `BULK_CHATS`). Every OF message carries a numeric
 * `queueId`; `isFromQueue` is true on every broadcast (6,512 of 6,512 mass rows, 2026-10-09) and on some sends the mass
 * history a run read does not list: bulk sends and single-chat queued sends (about 0.2% of DMs). On 2026-10-09 (account
 * 337749380, before the bulk mark), 671 non-mass outbound rows shared one of 6 queue ids, each in 8 to 321 of their
 * chats (OF set `isFromQueue` on 321 of the rows), and every other non-mass outbound row had a queue id of its own:
 * none was shared by 2 to 7 chats. The backfill uses the mass history; live rows (live.ts) use `isFromQueue`. Automated =
 * it matches the welcome message (text or media) or an automation text. `names` are the fan's names from the chat
 * list; any on the message's fan user object are added.
 */
export function deriveMessage(raw: Raw, chatId: number, ctx: DeriveContext, names: string[] = []): DerivedMessage | null {
  const messageId = num(raw.id);
  if (messageId === null) return null;
  const outbound = num((raw.fromUser as Raw | undefined)?.id) === ctx.accountId;
  const queueId = num(raw.queueId);
  const hash = textHash(raw.text);
  const media = mediaKey(raw.media);
  const isTip = raw.isTip === true;
  let automatedReason: DerivedMessage['automatedReason'] = null;
  if (outbound) {
    const w = ctx.welcome;
    if (w && ((hash !== null && hash === w.textHash) || (media !== null && media === w.mediaKey))) automatedReason = 'welcome';
    else if (hash !== null && ctx.automationHashes.has(hash)) automatedReason = 'automation';
  }
  return {
    messageId,
    chatId,
    direction: outbound ? 'outbound' : 'inbound',
    createdAt: new Date(String(raw.createdAt)),
    isMass: outbound && queueId !== null && (ctx.massSent.get(queueId) ?? 0) > 1,
    queueId,
    isAutomated: automatedReason !== null,
    automatedReason,
    priceCents: cents(raw.price) ?? 0,
    isTip,
    tipCents: isTip ? (cents(raw.tipAmount) ?? 0) : 0,
    isOpened: raw.isOpened === true,
    mediaCount: num(raw.mediaCount) ?? (Array.isArray(raw.media) ? raw.media.length : 0),
    mediaKey: media,
    textHash: outbound ? scriptHash(raw.text, [...names, ...messageFanNames(raw, chatId)]) : null,
    normaliserVersion: outbound ? NORMALISER_VERSION : null,
  };
}

/** The names on the fan's user object of a message (`fromUser` when the fan sent it, else `toUser`). */
export function messageFanNames(raw: Raw, chatId: number): string[] {
  return fanNames(num((raw.fromUser as Raw | undefined)?.id) === chatId ? raw.fromUser : raw.toUser);
}

export type DerivedPurchase = {
  txId: string;
  fanId: number | null;
  fanIdSource: 'field' | 'description' | null;
  /** OF's `descriptionDetails.type`, live: `message`, `tips`, `post`, `subscription`, `subscription_prolong`. */
  kind: string | null;
  grossCents: number | null;
  netCents: number | null;
  currency: string | null;
  createdAt: Date;
};

/**
 * The fan on a transaction: `user.id` when present (the reference product's transaction rows carry a `user`
 * object), else a numeric `u<id>` profile link in `description`, else unknown. A username link names no id.
 */
export function txFan(raw: Raw): Pick<DerivedPurchase, 'fanId' | 'fanIdSource'> {
  const field = num((raw.user as Raw | undefined)?.id);
  if (field !== null) return { fanId: field, fanIdSource: 'field' };
  const parsed = typeof raw.description === 'string' ? /onlyfans\.com\/u(\d+)(?![\w.-])/.exec(raw.description)?.[1] : undefined;
  if (parsed) return { fanId: Number(parsed), fanIdSource: 'description' };
  return { fanId: null, fanIdSource: null };
}

export function derivePurchase(raw: Raw): DerivedPurchase {
  const kind = (raw.descriptionDetails as Raw | undefined)?.type;
  return {
    txId: String(raw.id),
    ...txFan(raw),
    kind: typeof kind === 'string' ? kind : null,
    grossCents: cents(raw.amount),
    netCents: cents(raw.net),
    currency: typeof raw.currency === 'string' ? raw.currency : null,
    createdAt: new Date(String(raw.createdAt)),
  };
}
