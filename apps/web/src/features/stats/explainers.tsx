import type { StatsConfig } from '@api/contracts';
import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { COLORS } from './chart';
import { formatWindow } from './series';

// "How to read this": short text with small SVG drawings, redrawn from the step 0 showcase.

/** A stats page's collapsible "How to read this" block around its explainer. */
export function HowToReadDetails({ children }: { children: ReactNode }) {
  return (
    <details className="group rounded-xl border bg-card p-4">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
        How to read this
      </summary>
      <div className="mt-4">{children}</div>
    </details>
  );
}

type Windows = Pick<StatsConfig, 'replyCapSeconds' | 'slaSeconds' | 'openGapSeconds' | 'openReplySeconds'>;

const DEFAULTS: Windows = { replyCapSeconds: 43_200, slaSeconds: 900, openGapSeconds: 604_800, openReplySeconds: 86_400 };

export function HowToRead({ config }: { config?: Windows }) {
  const w = config ?? DEFAULTS;
  const gap = formatWindow(w.openGapSeconds);
  const openReply = formatWindow(w.openReplySeconds);
  const cap = formatWindow(w.replyCapSeconds);
  const sla = formatWindow(w.slaSeconds);
  return (
    <div className="divide-y">
      <Item title="What an opener is" drawing={<OpenerTimeline gap={gap} />}>
        An opener is a chatter's DM that restarts a quiet chat: no fan message and no DM for {gap} before it. Mass
        messages and the welcome message do not count as breaking the silence. If the fan wrote last, our DM is a late
        reply, not an opener. It counts as replied when the fan answers within {openReply}.
      </Item>
      <Item title="What counts as a reply within the cap" drawing={<ReplyWindows cap={cap} sla={sla} />}>
        A fan turn starts with the fan's first message after our last DM and ends at our next DM; mass and automated
        messages do not end it. Reply time only counts turns answered within {cap}: later answers are late, unanswered
        ones are breached once {cap} pass, and turns still inside {cap} are pending. The SLA % is the share answered
        within {sla}, out of every turn that is not pending.
      </Item>
      <Item title="How scripts are detected" drawing={<Normaliser />}>
        A script is a DM text sent 5 or more times in 3 or more chats within 30 days, on one account. Before texts are
        compared they are cleaned (HTML removed, lower case, spaces collapsed, the fan's name replaced by &lt;name&gt;), so
        "Hey Jessie" and "hey Mark" match while a different price stays a different script. Reply rate is the share of
        sends the fan answered within {openReply}; it shows what happened, not that the script caused it.
      </Item>
      <Item title='What "unverified" means' drawing={<VerifyFlow />}>
        Every number here is computed by our rules from the backfilled messages, and none has been checked by hand yet,
        so they are marked unverified. The morning check verifies them: open the sample chats in OF and confirm each
        opener and script is what it claims, then send the notes to the developer. Only after that is a metric marked
        verified.
      </Item>
    </div>
  );
}

function Item({ title, drawing, children }: { title: string; drawing: ReactNode; children: ReactNode }) {
  return (
    <div className="grid items-center gap-4 py-4 first:pt-0 last:pb-0 md:grid-cols-[1fr_minmax(0,380px)]">
      <div>
        <h3 className="font-medium">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{children}</p>
      </div>
      <div className="rounded-lg border bg-muted/30 p-2 text-foreground">{drawing}</div>
    </div>
  );
}

const label = { fontSize: 10, fill: 'currentColor' } as const;
const muted = { fontSize: 10, fill: 'var(--muted-foreground)' } as const;

function Dot({ x, y, color, r = 6, top, bottom }: { x: number; y: number; color: string; r?: number; top?: string; bottom?: string }) {
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill={color} />
      {top && (
        <text x={x} y={y - r - 4} textAnchor="middle" {...label}>
          {top}
        </text>
      )}
      {bottom && (
        <text x={x} y={y + r + 12} textAnchor="middle" {...muted}>
          {bottom}
        </text>
      )}
    </g>
  );
}

/** A bracket over `[x1, x2]` at height `y` with a caption above it. */
function Span({ x1, x2, y, color, text }: { x1: number; x2: number; y: number; color: string; text: string }) {
  return (
    <g>
      <path d={`M${x1} ${y + 5}V${y}H${x2}V${y + 5}`} fill="none" stroke={color} strokeWidth={1.5} />
      <text x={(x1 + x2) / 2} y={y - 4} textAnchor="middle" fontSize={10} fill={color}>
        {text}
      </text>
    </g>
  );
}

function OpenerTimeline({ gap }: { gap: string }) {
  return (
    <svg viewBox="0 0 380 190" className="h-auto w-full" role="img" aria-label="Opener timeline">
      <title>An opener after a quiet gap, and a late reply that is not an opener</title>
      <text x={8} y={14} fontSize={11} fontWeight={600} fill={COLORS.ok}>
        Opener (reactivation, replied)
      </text>
      <line x1={10} x2={370} y1={70} y2={70} stroke="var(--border)" strokeWidth={2} />
      <Span x1={36} x2={262} y={32} color={COLORS.ok} text={`${gap}+ quiet: no fan message, no DM`} />
      <Dot x={36} y={70} color={COLORS.primary} bottom="DM · Sep 1" />
      <Dot x={110} y={70} color={COLORS.grey} r={5} bottom="mass" />
      <Dot x={180} y={70} color={COLORS.grey} r={5} bottom="mass" />
      <Dot x={262} y={70} color={COLORS.ok} r={8} bottom="opener · Sep 11" />
      <Dot x={340} y={70} color={COLORS.fan} bottom="fan +40 min" />

      <text x={8} y={114} fontSize={11} fontWeight={600} fill={COLORS.bad}>
        Not an opener (late reply)
      </text>
      <line x1={10} x2={370} y1={160} y2={160} stroke="var(--border)" strokeWidth={2} />
      <Span x1={100} x2={290} y={128} color={COLORS.bad} text="9 days, but the fan wrote last" />
      <Dot x={36} y={160} color={COLORS.primary} bottom="DM · Sep 1" />
      <Dot x={100} y={160} color={COLORS.fan} bottom="fan · Sep 2" />
      <Dot x={290} y={160} color={COLORS.primary} bottom="DM · Sep 11" />
    </svg>
  );
}

function ReplyWindows({ cap, sla }: { cap: string; sla: string }) {
  return (
    <svg viewBox="0 0 380 150" className="h-auto w-full" role="img" aria-label="Reply windows">
      <title>Replies inside the SLA, inside the cap, and late</title>
      <rect x={30} y={40} width={250} height={40} rx={4} fill={COLORS.soft} opacity={0.35} />
      <rect x={30} y={40} width={50} height={40} rx={4} fill={COLORS.ok} opacity={0.35} />
      <text x={55} y={34} textAnchor="middle" fontSize={10} fill={COLORS.ok}>
        {sla} SLA
      </text>
      <text x={180} y={34} textAnchor="middle" fontSize={10} fill={COLORS.primary}>
        {cap} cap
      </text>
      <line x1={20} x2={370} y1={80} y2={80} stroke="var(--border)" strokeWidth={2} />
      <Dot x={30} y={80} color={COLORS.fan} bottom="fan writes" />
      <Dot x={65} y={60} color={COLORS.ok} r={5} />
      <Dot x={200} y={60} color={COLORS.primary} r={5} />
      <Dot x={335} y={60} color={COLORS.wait} r={5} />
      <text x={65} y={112} textAnchor="middle" {...label}>
        SLA met
      </text>
      <text x={200} y={112} textAnchor="middle" {...label}>
        in cap
      </text>
      <text x={335} y={112} textAnchor="middle" {...label}>
        late
      </text>
      <text x={190} y={138} textAnchor="middle" {...muted}>
        no reply after {cap} = breached · no reply yet, inside {cap} = pending
      </text>
    </svg>
  );
}

const STEPS: [string, string][] = [
  ['as sent', '<p>Hey <b>Jessie</b>!!  NEW set &amp; only $15 😘</p>'],
  ['strip HTML, lower case, collapse spaces', 'hey jessie !! new set & only $15 😘'],
  ["fan's name → <name>", 'hey <name> !! new set & only $15 😘'],
  ['hash (same for Mark; $20 is a different one)', '3f9c1e07a2b84d61'],
];

function Normaliser() {
  return (
    <svg viewBox="0 0 380 214" className="h-auto w-full" role="img" aria-label="Script normaliser, before and after">
      <title>A DM text cleaned step by step, then hashed</title>
      {STEPS.map(([caption, text], i) => {
        const y = 4 + i * 54;
        return (
          <g key={caption}>
            <text x={10} y={y + 10} {...muted}>
              {caption}
            </text>
            <rect x={6} y={y + 14} width={368} height={22} rx={4} fill="var(--background)" stroke="var(--border)" />
            <text x={14} y={y + 29} fontSize={11} fontFamily="ui-monospace, monospace" fill={i === 3 ? COLORS.primary : 'currentColor'}>
              {text}
            </text>
            {i < STEPS.length - 1 && (
              <path d={`M190 ${y + 38}v8m-4 -4l4 4l4 -4`} fill="none" stroke="var(--muted-foreground)" strokeWidth={1.2} />
            )}
          </g>
        );
      })}
    </svg>
  );
}

function VerifyFlow() {
  const boxes: [string, string, string][] = [
    ['Backfill computes', 'unverified', COLORS.wait],
    ['Morning check in OF', 'owner ticks samples', COLORS.primary],
    ['Notes reviewed', 'verified', COLORS.ok],
  ];
  return (
    <svg viewBox="0 0 380 80" className="h-auto w-full" role="img" aria-label="How a metric gets verified">
      <title>Computed numbers stay unverified until the morning check is done and reviewed</title>
      {boxes.map(([title, sub, color], i) => {
        const x = 4 + i * 128;
        return (
          <g key={title}>
            <rect x={x} y={14} width={112} height={50} rx={6} fill="var(--background)" stroke={color} strokeWidth={1.5} />
            <text x={x + 56} y={35} textAnchor="middle" fontSize={11} fontWeight={600} fill="currentColor">
              {title}
            </text>
            <text x={x + 56} y={52} textAnchor="middle" fontSize={10} fill={color}>
              {sub}
            </text>
            {i < boxes.length - 1 && (
              <path d={`M${x + 115} 39h10m-4 -4l4 4l-4 4`} fill="none" stroke="var(--muted-foreground)" strokeWidth={1.2} />
            )}
          </g>
        );
      })}
    </svg>
  );
}

const REVENUE_TERMS: [string, string][] = [
  [
    'Gross and net',
    "OF's amount (what the fan paid) and net (after OF's fee) of each transaction in the range, summed, in USD. Refunded or reversed transactions (OF's status undo or pending_return) are left out. Settled is the gross OF has cleared (status done), pending what it still holds (loading). Transactions are stored by the analytics backfill, so a range it never read shows nothing. Days are in the stats timezone.",
  ],
  [
    'Kind',
    "OF's transaction type: message (a PPV bought in chat), tips, subscription, subscription_prolong (a renewal), post (a paid post); unknown when OF gave none.",
  ],
  ['Payers', 'Fans with a transaction in the range, per account. A transaction whose fan is unknown counts in the sums only.'],
  [
    'Fan CVR',
    'Payers ÷ fans messaged: the fans with any message in the range, from either side, not unsent. Per account, like payers. A payer need not have been messaged, so it can pass 100%.',
  ],
  [
    'Golden ratio',
    "Infloww's formula: PPV DMs sent ÷ DMs sent. A DM is an outbound message that is not mass and not automated (welcome message or automation); a PPV DM is a priced one. Unsent ones count.",
  ],
  [
    'PPV unlock',
    "Priced DMs (not mass) sent in the range. Unsent PPVs still count as sent; a fan who bought before the unsend keeps it. Opened is OF's isOpened flag as of the last read, so the rate is an upper bound: opened counts as bought.",
  ],
  [
    'Top payers',
    "The 50 fans who paid the most in the range, with the name on their newest transaction. Chat says whether any message of theirs is stored; open it in Conversations.",
  ],
];

/** The Revenue page's "How to read this": each number's definition. */
export function RevenueTerms() {
  return (
    <dl className="divide-y">
      {REVENUE_TERMS.map(([term, text]) => (
        <div key={term} className="py-3 first:pt-0 last:pb-0">
          <dt className="font-medium">{term}</dt>
          <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">{text}</dd>
        </div>
      ))}
    </dl>
  );
}
