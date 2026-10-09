import { z } from 'zod';
import { AppError } from './errors.js';

// Keyset cursors: the last row's sort key as base64url JSON, opaque to the caller (`cursor` in, `nextCursor` out).

/** An ISO time in a cursor, as `toISOString()` writes it. */
export const cursorTime = z.iso.datetime({ offset: true });

/**
 * A keyset cursor whose sort key is `schema`, read from a row by `keyOf`. `decode` parses a `cursor` (400
 * `invalid_cursor` when it is not one); `page` keeps the first `limit` of up to `limit + 1` fetched rows, with the
 * last one's cursor when more matched.
 */
export function keysetCursor<S extends z.ZodType<readonly unknown[]>, R>(schema: S, keyOf: (row: R) => Readonly<z.output<S>>) {
  return {
    decode(cursor: string): z.output<S> {
      let value: unknown;
      try {
        value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      } catch {
        // invalid below
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new AppError(400, 'invalid_cursor', 'The cursor is invalid');
      return parsed.data;
    },
    page<T extends R>(rows: T[], limit: number): { items: T[]; nextCursor: string | null } {
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify(keyOf(last))).toString('base64url') : null;
      return { items, nextCursor };
    },
  };
}

/** The cursor over (created_at desc, id desc) of logs and webhook deliveries. */
export const timeIdCursor = keysetCursor(
  z.tuple([cursorTime, z.string()]),
  (row: { createdAt: Date; id: string }) => [row.createdAt.toISOString(), row.id] as const,
);
