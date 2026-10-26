import { describe, expect, it } from 'vitest';
import { ACTIONS_COLUMN } from './table-layout';

describe('ACTIONS_COLUMN', () => {
  it('pins the row menu to the right edge with an opaque background', () => {
    const classes = ACTIONS_COLUMN.split(' ');
    expect(classes).toEqual(expect.arrayContaining(['sticky', 'right-0', 'bg-background']));
  });
});
