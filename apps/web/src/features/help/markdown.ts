import { linkTarget, type LinkTarget } from './links';

// The small markdown subset the help assistant writes, parsed into tokens that AnswerText renders as React nodes:
// model output never reaches the DOM as HTML.

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'bold' | 'italic'; children: Inline[] }
  | { type: 'link'; children: Inline[]; target: LinkTarget };

type Block = { type: 'p'; lines: string[] } | { type: 'ul' | 'ol'; items: string[] };

/**
 * `code`, then **bold**, then *italic*, then [text](href). Emphasis needs a non-space, non-`*` character just inside
 * each marker, so `2 * 3 * 4` stays text; anything unmatched (an unclosed `**`) stays text.
 */
const TOKEN = /`([^`\n]+)`|\*\*([^\s*](?:.*?[^\s*])?)\*\*|\*([^\s*](?:[^*\n]*[^\s*])?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** One line of an answer as inline tokens. A link that fails `linkTarget` becomes its label, with no href. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const push = (t: string) => {
    if (!t) return;
    const last = out.at(-1);
    if (last?.type === 'text') last.text += t;
    else out.push({ type: 'text', text: t });
  };
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    push(text.slice(at, m.index));
    at = m.index + m[0].length;
    const [, code, bold, italic, label, href] = m;
    if (code !== undefined) out.push({ type: 'code', text: code });
    else if (bold !== undefined) out.push({ type: 'bold', children: parseInline(bold) });
    else if (italic !== undefined) out.push({ type: 'italic', children: parseInline(italic) });
    else {
      const target = linkTarget(href!);
      const children = parseInline(label!);
      if (target) out.push({ type: 'link', children, target });
      else for (const c of children) c.type === 'text' ? push(c.text) : out.push(c);
    }
  }
  push(text.slice(at));
  return out;
}

/** Paragraphs (split by blank lines) and `-` / `1.` lists; any other markdown stays as its text. */
export function parseBlocks(text: string): Block[] {
  const out: Block[] = [];
  let gap = true;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) {
      gap = true;
      continue;
    }
    const last = out.at(-1);
    const item = /^(?:([-*])|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const type = item[1] ? 'ul' : 'ol';
      // A blank line between two items of one list keeps the list.
      if (last?.type === type) last.items.push(item[2]!);
      else out.push({ type, items: [item[2]!] });
    } else if (last?.type === 'p' && !gap) last.lines.push(line);
    else out.push({ type: 'p', lines: [line] });
    gap = false;
  }
  return out;
}
