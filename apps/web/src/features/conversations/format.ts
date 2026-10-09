import type { StatsMessage } from '@api/contracts';
import { formatMoney } from '@/lib/utils';

const hasMedia = (m: StatsMessage) => m.mediaCount > 0 || m.gifs > 0;

/** Why a message has no text, shown in place of it. */
export function noTextLabel(m: StatsMessage): string {
  if (hasMedia(m)) return 'No text: media only';
  if (m.isTip) return 'No text: tip only';
  return 'No text in this message';
}

/** `1 photo · 2 videos`, else `3 media` when OF gave no types. */
function mediaLabel(m: StatsMessage): string {
  const parts = (
    [
      [m.photos, 'photo'],
      [m.videos, 'video'],
      [m.audios, 'audio'],
      [m.gifs, 'gif'],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, kind]) => `${n} ${kind}${n === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : `${m.mediaCount} media`;
}

export type MessageBadge = { label: string; variant: 'secondary' | 'outline' | 'destructive' };

/** A message's money, media and kind badges, in reading order. */
export function messageBadges(m: StatsMessage): MessageBadge[] {
  const badges: MessageBadge[] = [];
  if (m.priceCents > 0) badges.push({ label: `PPV ${formatMoney(m.priceCents)} · ${m.isOpened ? 'bought' : 'not bought'}`, variant: 'secondary' });
  if (m.isTip) badges.push({ label: m.tipCents > 0 ? `Tip ${formatMoney(m.tipCents)}` : 'Tip', variant: 'secondary' });
  if (hasMedia(m)) badges.push({ label: mediaLabel(m), variant: 'outline' });
  if (m.isMass) badges.push({ label: 'Mass', variant: 'outline' });
  if (m.isAutomated) badges.push({ label: m.automatedReason ? `Automated (${m.automatedReason})` : 'Automated', variant: 'outline' });
  if (m.deletedAt) badges.push({ label: 'Unsent', variant: 'destructive' });
  return badges;
}

/**
 * A mass message the "Hide mass not bought" toggle hides: all but those the fan bought. Both flags are as of the last
 * read (backfill or live event), so a PPV bought since reads not bought, and a live queued DM may read as mass.
 */
export const isHiddenMass = (m: StatsMessage) => m.isMass && !(m.priceCents > 0 && m.isOpened);

/** Consecutive messages grouped by their day (`YYYY-MM-DD`) in the IANA timezone `tz`, keeping order. */
export function byDay(items: StatsMessage[], tz: string): { day: string; items: StatsMessage[] }[] {
  // en-CA formats as ISO.
  const dayOf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const groups: { day: string; items: StatsMessage[] }[] = [];
  for (const m of items) {
    const day = dayOf.format(new Date(m.createdAt));
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(m);
    else groups.push({ day, items: [m] });
  }
  return groups;
}
