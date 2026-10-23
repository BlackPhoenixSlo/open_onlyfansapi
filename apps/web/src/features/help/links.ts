import { nav, type NavRoute } from '@/lib/nav';

// The help assistant's answers are model output: a link becomes clickable only when its target passes this allowlist.

/** Where an allowed link goes: a dashboard page (TanStack `<Link>`), or a page opened in a new tab. */
export type LinkTarget =
  | { kind: 'route'; to: NavRoute; search: Record<string, string> }
  | { kind: 'external'; href: string };

/** Served by the API, not the dashboard's router. */
const API_PAGES = ['/docs', '/openapi.json'];
/** The public mirror's README and docs (scripts/mirror-public.sh), with an optional anchor. */
const DOCS_URL =
  /^https:\/\/github\.com\/BlackPhoenixSlo\/open_onlyfansapi\/blob\/master\/(README\.md|docs\/[\w-]+\.md|deploy\/hostinger\.md)(#[\w-]+)?$/;

/** The target of a markdown link's `href`, or null when it is not allowed (it then renders as plain text). */
export function linkTarget(href: string): LinkTarget | null {
  if (API_PAGES.includes(href) || DOCS_URL.test(href)) return { kind: 'external', href };
  const m = /^(\/[a-z-]+)(?:\?([^#\s]*))?$/.exec(href);
  const item = nav.find((i) => i.to === m?.[1]);
  if (!m || !item) return null;
  return { kind: 'route', to: item.to, search: Object.fromEntries(new URLSearchParams(m[2] ?? '')) };
}
