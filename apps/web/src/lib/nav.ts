import type { Me, MemberFeature } from '@api/contracts';

/** Who sees an item: everyone, the owner only, or team members holding a feature (plan-team §2.4). */
type Access = 'all' | 'owner' | MemberFeature;

/**
 * The sidebar, in order. Also the help assistant's link allowlist (features/help/links.ts), and
 * features/help/manual.test.ts checks the assistant's manual has a section for each, so neither drifts from the sidebar.
 */
export const nav = [
  { to: '/dashboard', label: 'Home', access: 'all' },
  { to: '/accounts', label: 'Accounts', access: 'owner' },
  { to: '/keys', label: 'API keys', access: 'owner' },
  { to: '/team', label: 'Team', access: 'owner' },
  { to: '/logs', label: 'Logs', access: 'owner' },
  { to: '/usage', label: 'Usage', access: 'owner' },
  { to: '/stats', label: 'Stats', access: 'stats' },
  { to: '/conversations', label: 'Conversations', access: 'stats' },
  { to: '/revenue', label: 'Revenue', access: 'stats' },
  { to: '/webhooks', label: 'Webhooks', access: 'owner' },
  { to: '/playground', label: 'Playground', access: 'all' },
  { to: '/settings', label: 'Settings', access: 'owner' },
] as const satisfies readonly { to: string; label: string; access: Access }[];

export type NavRoute = (typeof nav)[number]['to'];

/**
 * The owner's view unless /api/me confirms a team member, so the owner's nav never depends on it. The API enforces
 * the same rules; this only hides dead ends.
 */
export function canSee(access: Access, me: Me | undefined): boolean {
  if (access === 'all' || me?.role !== 'member') return true;
  return access !== 'owner' && me.features.includes(access);
}
