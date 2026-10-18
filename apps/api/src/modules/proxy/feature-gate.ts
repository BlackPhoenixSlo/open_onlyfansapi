import { memberFeature, type MemberFeature } from '../../contracts.js';

/**
 * The first path segments each feature reaches through the proxy, from the upstream route modules
 * (`services/upstream/routes/*.py`, plan-team §2.2). The raw passthrough `_of` is no feature's: members never reach it.
 * A test fails when an upstream segment is missing here.
 */
export const SEGMENTS_BY_FEATURE: Record<MemberFeature, readonly string[]> = {
  chats: ['chats', 'giphy'], // chats.py
  mass_messages: ['mass-messaging', 'queue'], // chats.py, the scheduled-send routes
  vault: ['media', 'posts', 'stories', 'saved-for-later'], // content.py
  fans: ['fans', 'following', 'users', 'user-lists', 'me', 'subscribers'], // fans.py
  stats: ['payouts', 'transactions', 'chargebacks', 'statistics', 'engagement'], // money.py
  promo: ['tracking-links', 'trial-links', 'promotions', 'bundles'], // promo.py
  settings: ['settings', 'notifications', 'release-forms'], // settings.py
};

const FEATURE_BY_SEGMENT = new Map(
  memberFeature.options.flatMap((feature) => SEGMENTS_BY_FEATURE[feature].map((s) => [s, feature] as const)),
);

/** The first segment of `/<rest>?<query>` (as returned by `resolveUpstream`), decoded; null when undecodable. */
function firstSegment(rest: string): string | null {
  const segment = rest.slice(1).split(/[/?]/, 1)[0] ?? '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Whether `/<rest>?<query>` (as returned by `resolveUpstream`) is the raw passthrough `/_of/…`: its first segment,
 * decoded, is `_of`, so `%5Fof` counts too. Passthrough responses are forwarded as they are (plan-v5 §2.2).
 */
export function isPassthrough(rest: string): boolean {
  return firstSegment(rest) === '_of';
}

/**
 * The feature a team member needs for the proxied route `/<rest>?<query>` (plan-team §1.5): `'owner'` for the raw
 * passthrough (`_of`, `%5Fof` too), null for any segment no feature names (fail closed). `gateMember` answers both.
 */
export function proxyFeature(rest: string): MemberFeature | 'owner' | null {
  const segment = firstSegment(rest);
  if (segment === '_of') return 'owner';
  return FEATURE_BY_SEGMENT.get(segment ?? '') ?? null;
}

