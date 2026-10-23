import { describe, expect, it } from 'vitest';
import { parseBlocks, parseInline } from './markdown';

const keys = { kind: 'route', to: '/keys', search: {} } as const;

describe('parseInline', () => {
  it('turns allowed links into links and the rest into their text', () => {
    expect(parseInline('Open [API keys](/keys), not [this](https://evil.example).')).toEqual([
      { type: 'text', text: 'Open ' },
      { type: 'link', children: [{ type: 'text', text: 'API keys' }], target: keys },
      { type: 'text', text: ', not this.' },
    ]);
  });

  it('reads bold, italic and code, and leaves an unclosed ** as text', () => {
    expect(parseInline('Press **Create key**, set *Scope* to `read`')).toEqual([
      { type: 'text', text: 'Press ' },
      { type: 'bold', children: [{ type: 'text', text: 'Create key' }] },
      { type: 'text', text: ', set ' },
      { type: 'italic', children: [{ type: 'text', text: 'Scope' }] },
      { type: 'text', text: ' to ' },
      { type: 'code', text: 'read' },
    ]);
    expect(parseInline('a **b c')).toEqual([{ type: 'text', text: 'a **b c' }]);
  });

  it('needs a non-space just inside each emphasis marker', () => {
    for (const text of ['2 * 3 * 4', '2 ** 3 ** 4', 'a * b', '** a **']) {
      expect(parseInline(text), text).toEqual([{ type: 'text', text }]);
    }
  });

  it('parses a link inside bold, and bold inside a link label', () => {
    expect(parseInline('**[Team](/team)**')).toEqual([
      { type: 'bold', children: [{ type: 'link', children: [{ type: 'text', text: 'Team' }], target: { kind: 'route', to: '/team', search: {} } }] },
    ]);
    expect(parseInline('[**API keys**](/keys)')).toEqual([
      { type: 'link', children: [{ type: 'bold', children: [{ type: 'text', text: 'API keys' }] }], target: keys },
    ]);
    expect(parseInline('see [**here**](/foo) now')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'bold', children: [{ type: 'text', text: 'here' }] },
      { type: 'text', text: ' now' },
    ]);
  });
});

describe('parseBlocks', () => {
  it('splits paragraphs on blank lines and keeps line breaks inside one', () => {
    expect(parseBlocks('One\ntwo\n\n  Three  ')).toEqual([
      { type: 'p', lines: ['One', 'two'] },
      { type: 'p', lines: ['Three'] },
    ]);
  });

  it('reads - and 1. lists, and a blank line between two items keeps the list', () => {
    expect(parseBlocks('Steps:\n1. Open it\n\n2) Press **Send**\n- a\n* b\nAfter')).toEqual([
      { type: 'p', lines: ['Steps:'] },
      { type: 'ol', items: ['Open it', 'Press **Send**'] },
      { type: 'ul', items: ['a', 'b'] },
      { type: 'p', lines: ['After'] },
    ]);
  });

  it('leaves other markdown as text', () => {
    expect(parseBlocks('# Title\n> quote\n-no space')).toEqual([{ type: 'p', lines: ['# Title', '> quote', '-no space'] }]);
    expect(parseBlocks('')).toEqual([]);
  });
});
