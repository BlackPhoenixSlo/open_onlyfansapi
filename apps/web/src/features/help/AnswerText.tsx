import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { parseBlocks, parseInline, type Inline } from './markdown';

function Inlines({ tokens, onNavigate }: { tokens: Inline[]; onNavigate?: () => void }): ReactNode {
  return tokens.map((t, i) => {
    switch (t.type) {
      case 'text':
        return t.text;
      case 'code':
        return (
          <code key={i} className="rounded bg-background/70 px-1 py-0.5 font-mono text-[0.85em] break-all">
            {t.text}
          </code>
        );
      case 'bold':
        return (
          <strong key={i} className="font-semibold">
            <Inlines tokens={t.children} onNavigate={onNavigate} />
          </strong>
        );
      case 'italic':
        return (
          <em key={i}>
            <Inlines tokens={t.children} onNavigate={onNavigate} />
          </em>
        );
      case 'link':
        return t.target.kind === 'route' ? (
          <Link key={i} to={t.target.to} search={t.target.search} onClick={onNavigate} className="font-medium underline underline-offset-2">
            <Inlines tokens={t.children} />
          </Link>
        ) : (
          <a key={i} href={t.target.href} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
            <Inlines tokens={t.children} />
          </a>
        );
    }
  });
}

/**
 * An answer as React nodes: a small markdown subset (paragraphs, lists, bold, italic, code, allowed links). Model output
 * never reaches the DOM as HTML. `onNavigate` runs when a dashboard link is followed.
 */
export function AnswerText({ text, onNavigate }: { text: string; onNavigate?: () => void }) {
  return (
    <div className="space-y-2">
      {parseBlocks(text).map((b, i) => {
        if (b.type === 'p') {
          return (
            <p key={i}>
              {b.lines.map((line, j) => (
                <span key={j}>
                  {j > 0 && <br />}
                  <Inlines tokens={parseInline(line)} onNavigate={onNavigate} />
                </span>
              ))}
            </p>
          );
        }
        const List = b.type;
        return (
          <List key={i} className={`space-y-1 pl-5 ${b.type === 'ul' ? 'list-disc' : 'list-decimal'}`}>
            {b.items.map((item, j) => (
              <li key={j}>
                <Inlines tokens={parseInline(item)} onNavigate={onNavigate} />
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
