import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nav } from '@/lib/nav';
import { DOCS, MANUAL } from '@api/modules/help/manual';
import { SYSTEM_PROMPT } from '@api/modules/help/prompt';
import { linkTarget } from './links';

// The drift gate: the help assistant's manual (apps/api) against the sidebar and the link allowlist the answers are
// rendered with. The system prompt holds the rules, the few-shot examples and the manual.

const root = fileURLToPath(new URL('../../../../../', import.meta.url));

describe("the help assistant's manual", () => {
  it('has one "## [Label](/route)" section for every sidebar item', () => {
    for (const item of nav) {
      const sections = MANUAL.match(new RegExp(`^## \\[${item.label}\\]\\(${item.to}\\)$`, 'gm'));
      expect(sections, item.to).toHaveLength(1);
    }
  });

  it('links only what the answers may link, and every doc it links exists', () => {
    const hrefs = [...SYSTEM_PROMPT.matchAll(/\]\(([^)]*)\)/g)].map((m) => m[1]!);
    expect(hrefs.length).toBeGreaterThan(30);
    for (const href of hrefs) {
      const target = linkTarget(href);
      expect(target, href).not.toBeNull();
      if (target?.kind === 'external' && href.startsWith(`${DOCS}/`)) {
        expect(existsSync(root + href.slice(DOCS.length + 1).split('#')[0]), href).toBe(true);
      }
    }
  });
});
