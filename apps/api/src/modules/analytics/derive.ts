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
 * The script normaliser (§4.4), version 1: strip tags (each becomes a space, so `<p>a</p><p>b</p>` stays two
 * words), unescape HTML, NFKC, lowercase, collapse whitespace. Tags go first so an escaped `&lt;3` survives.
 * Not yet done: replacing the fan's name, username and custom name with `<name>`.
 */
export function normaliseText(html: string): string {
  return unescapeHtml(html.replace(/<[^>]*>/g, ' '))
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** SHA-256 of the normalised text, first 16 hex; null when nothing is left. */
export function textHash(html: unknown): string | null {
  const text = typeof html === 'string' ? normaliseText(html) : '';
  return text ? createHash('sha256').update(text).digest('hex').slice(0, 16) : null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
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
  mediaCount: number;
  mediaKey: string | null;
  textHash: string | null;
};

/**
 * Derived columns of one OF message in chat `chatId`; null when it has no numeric `id`. Outbound = `fromUser.id` is
 * the account. Mass = its `queueId` is a broadcast with `sentCount > 1` (`isFromQueue` is not trusted). Automated =
 * it matches the welcome message (text or media) or an automation text.
 */
export function deriveMessage(raw: Raw, chatId: number, ctx: DeriveContext): DerivedMessage | null {
  const messageId = num(raw.id);
  if (messageId === null) return null;
  const outbound = num((raw.fromUser as Raw | undefined)?.id) === ctx.accountId;
  const queueId = num(raw.queueId);
  const hash = textHash(raw.text);
  const media = mediaKey(raw.media);
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
    isTip: raw.isTip === true,
    mediaCount: num(raw.mediaCount) ?? (Array.isArray(raw.media) ? raw.media.length : 0),
    mediaKey: media,
    textHash: outbound ? hash : null,
  };
}

export type DerivedPurchase = {
  txId: string;
  fanId: number | null;
  fanIdSource: 'field' | 'description' | null;
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
  return {
    txId: String(raw.id),
    ...txFan(raw),
    kind: typeof raw.type === 'string' ? raw.type : null,
    grossCents: cents(raw.amount),
    netCents: cents(raw.net),
    currency: typeof raw.currency === 'string' ? raw.currency : null,
    createdAt: new Date(String(raw.createdAt)),
  };
}
