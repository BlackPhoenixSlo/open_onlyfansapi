import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/** Radix Select can't use '' as an item value. */
const ALL = 'all';

/** A filter dropdown whose first item (`all`) clears the filter (`undefined`). */
export function FilterSelect({
  all,
  value,
  options,
  onChange,
  className = 'w-40',
}: {
  all: string;
  value: string | undefined;
  options: { value: string; label: string }[];
  onChange: (value: string | undefined) => void;
  className?: string;
}) {
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
      <SelectTrigger className={className} aria-label={all}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{all}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
