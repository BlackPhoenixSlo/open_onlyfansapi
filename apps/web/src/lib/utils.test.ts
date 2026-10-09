import { describe, expect, it } from 'vitest';
import { fanFileName, fanName } from './utils';

describe('fan names', () => {
  it('names a fan by username, else chat id, for display and for file names', () => {
    expect([fanName({ fanUsername: 'Ann', chatId: 7 }), fanName({ fanUsername: null, chatId: 7 })]).toEqual(['@Ann', 'chat 7']);
    expect([fanFileName({ fanUsername: 'Ann', chatId: 7 }), fanFileName({ fanUsername: null, chatId: 7 })]).toEqual(['Ann', 'chat-7']);
  });
});
