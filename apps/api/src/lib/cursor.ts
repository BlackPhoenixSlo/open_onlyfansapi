import { z } from 'zod';
import { AppError } from './errors.js';

// Keyset cursors: the last row's sort key as base64url JSON, opaque to the caller (`cursor` in, `nextCursor` out).

/** An ISO time in a cursor: any string `Date.parse` reads. */
export const cursorTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)));

/** The sort key `values` as a cursor. */
export const encodeCursor = (values: readonly unknown[]) => Buffer.from(JSON.stringify(values)).toString('base64url');

/** The sort key in `cursor`, checked against `schema`; 400 `invalid_cursor` when it is not one. */
export function decodeCursor<T extends z.ZodType>(cursor: string, schema: T): z.infer<T> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  } catch {
    // invalid below
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError(400, 'invalid_cursor', 'The cursor is invalid');
  return parsed.data;
}
