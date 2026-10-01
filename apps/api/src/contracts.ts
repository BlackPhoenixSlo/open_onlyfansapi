// Wire types shared with apps/web (imported there via the `@api/contracts` alias, types only).
import { z } from 'zod';

export const keyScope = z.enum(['read', 'write']);
export type KeyScope = z.infer<typeof keyScope>;

export const apiKey = z.object({
  id: z.string(),
  name: z.string(),
  start: z.string(),
  scope: keyScope,
  allowedAccountIds: z.array(z.number().int()).nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ApiKey = z.infer<typeof apiKey>;

const keyName = z.string().trim().min(1).max(100);
/** null = all accounts the workspace can reach */
const allowedAccountIds = z.array(z.number().int().positive()).min(1).nullable();

export const createKeyBody = z.object({
  name: keyName,
  scope: keyScope.default('read'),
  allowedAccountIds: allowedAccountIds.default(null),
});
export type CreateKeyBody = z.input<typeof createKeyBody>;

// No defaults here: an omitted field is left unchanged.
export const updateKeyBody = z.object({
  name: keyName.optional(),
  scope: keyScope.optional(),
  allowedAccountIds: allowedAccountIds.optional(),
});
export type UpdateKeyBody = z.input<typeof updateKeyBody>;

export const keyList = z.object({ items: z.array(apiKey) });
export const createdKey = z.object({ key: apiKey, secret: z.string() });
export type CreatedKey = z.infer<typeof createdKey>;

export const account = z.object({
  id: z.number().int(),
  label: z.string().nullable(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  status: z.string(),
});
export type Account = z.infer<typeof account>;
export const accountList = z.object({ items: z.array(account) });

export const whoami = z.object({
  team: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    backendUserId: z.number().int().nullable(),
  }),
  key: apiKey.pick({ id: true, name: true, scope: true, allowedAccountIds: true }).nullable(),
  user: z.object({ id: z.string() }).nullable(),
});
export type Whoami = z.infer<typeof whoami>;

export type ErrorBody = { error: { code: string; message: string; requestId: string } };
