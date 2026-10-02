import { describe, expect, it } from 'vitest';
import { formatValidationError } from './api';

describe('formatValidationError', () => {
  it('turns field paths into readable labels', () => {
    expect(formatValidationError('/url Invalid URL')).toBe('URL: Invalid URL');
    expect(formatValidationError('/description Too big; /events/0 Invalid option')).toBe(
      'Description: Too big; Events 0: Invalid option',
    );
  });

  it('leaves root-level and unrecognised messages alone', () => {
    expect(formatValidationError('/ Invalid input')).toBe('Invalid input');
    expect(formatValidationError('Something else')).toBe('Something else');
  });
});
