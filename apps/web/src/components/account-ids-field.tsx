import type { Account } from '@api/contracts';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** `<id> (<label or username>)`, how the dashboard names a creator account. */
export const accountLabel = (a: Account) => `${a.id} (${a.label ?? a.username ?? 'unnamed'})`;

/**
 * The comma-separated account allowlist of the API key and team permission dialogs. What an empty field means is the
 * caller's (`emptyMeans`): all accounts for a key, none for a member limited to some creators.
 */
export function AccountIdsField({
  id,
  label,
  value,
  onChange,
  accounts,
  emptyMeans = 'all accounts',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  accounts: Account[];
  emptyMeans?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={`Empty: ${emptyMeans}`} />
      <p className="text-xs text-muted-foreground">
        Comma-separated, e.g. 12, 34. Leave empty for {emptyMeans}.
        {accounts.length > 0 && ` Available: ${accounts.map(accountLabel).join(', ')}.`}
      </p>
    </div>
  );
}

/** Empty → null (the caller decides what that means); invalid → undefined. */
export function parseAccountIds(text: string): number[] | null | undefined {
  const parts = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const ids = parts.map(Number);
  return ids.every((n) => Number.isInteger(n) && n > 0) ? ids : undefined;
}

export const INVALID_ACCOUNT_IDS = 'Account IDs must be positive whole numbers separated by commas';
