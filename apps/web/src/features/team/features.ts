import type { MemberFeature } from '@api/contracts';

/** What each team feature unlocks (team-contracts.ts `memberFeature`, plan-team §2.2), listed in the enum's order. */
export const FEATURE_LABELS: Record<MemberFeature, string> = {
  chats: 'Chats',
  mass_messages: 'Mass messages and queue',
  vault: 'Vault, posts and stories',
  fans: 'Fans and lists',
  // Includes `GET /v1/stats/messages` (stored DM text) and `/v1/stats/fans` (each fan's spend).
  stats: 'Stats, earnings, stored messages and fan spend',
  promo: 'Promotions',
  settings: 'Creator settings',
};

// The web imports `@api/contracts` for types only (no runtime alias, no zod in the bundle), so the list comes from the
// labels: `Record<MemberFeature, string>` makes them name every feature and nothing else. The order is the literal's
// above (kept like the enum's by hand); the type does not check it.
export const FEATURES = Object.keys(FEATURE_LABELS) as MemberFeature[];

/** Features as their labels, comma-separated; `none` when the list is empty. */
export function featureList(features: MemberFeature[], none = 'None') {
  return features.length ? features.map((f) => FEATURE_LABELS[f]).join(', ') : none;
}
