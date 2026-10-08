import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

/** Chart colours; mid-tone so they read on the light and the dark theme. */
export const COLORS = {
  primary: 'oklch(0.55 0.17 255)',
  soft: 'oklch(0.75 0.09 255)',
  ok: 'oklch(0.62 0.15 150)',
  bad: 'oklch(0.62 0.19 25)',
  wait: 'oklch(0.8 0.14 80)',
  fan: 'oklch(0.72 0.16 55)',
  grey: 'oklch(0.78 0 0)',
};

export type ChartSeries = {
  key: string;
  label: string;
  color: string;
  type: 'line' | 'bar';
  /** Bars with the same stack id stack. */
  stack?: string;
};

const tick = { fill: 'var(--muted-foreground)', fontSize: 12 };

/** One line/bar chart for every stats series: `data` rows keyed by `x`, one line or bar per `series` entry. */
export function Chart({
  data,
  x,
  series,
  format,
  xFormat = (v) => v,
  xLabel,
  yLabel,
  yMax,
  height = 240,
}: {
  data: Record<string, string | number | null>[];
  x: string;
  series: ChartSeries[];
  /** Formats y values, on the axis and in the tooltip. */
  format: (v: number) => string;
  xFormat?: (v: string) => string;
  xLabel: string;
  yLabel: string;
  yMax?: number;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 16, left: 8 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey={x}
          tick={tick}
          tickLine={false}
          axisLine={false}
          tickFormatter={xFormat}
          minTickGap={12}
          label={{ value: xLabel, position: 'insideBottom', offset: -10, fill: 'var(--muted-foreground)', fontSize: 12 }}
        />
        <YAxis
          tick={tick}
          tickLine={false}
          axisLine={false}
          width={64}
          domain={[0, yMax ?? 'auto']}
          allowDecimals={false}
          tickFormatter={(v: number) => format(v)}
          label={{ value: yLabel, angle: -90, position: 'insideLeft', fill: 'var(--muted-foreground)', fontSize: 12, dy: 40 }}
        />
        <Tooltip
          cursor={{ fill: 'var(--muted)' }}
          labelFormatter={(v) => xFormat(String(v))}
          formatter={(v) => (typeof v === 'number' ? format(v) : '—')}
          contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}
        />
        {series.length > 1 && <Legend verticalAlign="top" height={28} iconType="circle" />}
        {series.map((s) =>
          s.type === 'line' ? (
            <Line
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              strokeWidth={2}
              dot={{ r: 2.5 }}
              connectNulls
              type="monotone"
              isAnimationActive={false}
            />
          ) : (
            <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} stackId={s.stack} isAnimationActive={false} />
          ),
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
