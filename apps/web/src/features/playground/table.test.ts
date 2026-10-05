import { describe, expect, it } from 'vitest';
import { responseTable } from './table';

describe('responseTable', () => {
  it('tabulates rows, items or data of flat objects', () => {
    const t = responseTable(JSON.stringify({ rows: [{ day: '2026-10-01', count: 2 }, { day: '2026-10-02', type: 'x' }] }));
    expect(t).toEqual({
      key: 'rows',
      total: 2,
      columns: ['day', 'count', 'type'],
      rows: [{ day: '2026-10-01', count: 2 }, { day: '2026-10-02', type: 'x' }],
    });
    expect(responseTable(JSON.stringify({ data: [{ id: 1 }], _meta: {} }))?.key).toBe('data');
    expect(responseTable(JSON.stringify({ items: Array.from({ length: 150 }, (_, id) => ({ id })) }))).toMatchObject({ total: 150 });
    expect(responseTable(JSON.stringify({ items: Array.from({ length: 150 }, (_, id) => ({ id })) }))?.rows).toHaveLength(100);
  });

  it('skips nested, empty and non-list bodies', () => {
    expect(responseTable(JSON.stringify({ data: [{ user: { id: 1 } }] }))).toBeNull();
    expect(responseTable(JSON.stringify({ rows: [] }))).toBeNull();
    expect(responseTable(JSON.stringify({ data: { id: 1 } }))).toBeNull();
    expect(responseTable('not json')).toBeNull();
  });
});
