import type { WebhookEndpoint } from '@api/contracts';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';

export type WebhookHealthState = 'ok' | 'failing' | 'paused';

const TONE: Record<WebhookHealthState, string> = {
  ok: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  failing: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  paused: 'bg-destructive/10 text-destructive dark:bg-destructive/20',
};

/** The colour for each health state, shared by the webhooks pages and Home. */
export function WebhookHealthBadge({
  health,
  title,
  children,
}: {
  health: WebhookHealthState;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <Badge className={TONE[health]} title={title}>
      {children ?? health}
    </Badge>
  );
}

/** ok / failing / paused, from `enabled`, `pausedReason` and `consecutiveFailures`. */
export function WebhookHealth({ endpoint }: { endpoint: WebhookEndpoint }) {
  if (!endpoint.enabled) {
    return endpoint.pausedReason === 'failures' ? (
      <WebhookHealthBadge health="paused" title={`Paused after ${endpoint.consecutiveFailures} failed deliveries`}>
        paused (failures)
      </WebhookHealthBadge>
    ) : (
      <WebhookHealthBadge health="paused" title="Paused manually" />
    );
  }
  if (endpoint.consecutiveFailures > 0) {
    return (
      <WebhookHealthBadge
        health="failing"
        title={`${endpoint.consecutiveFailures} failed deliveries since the last success`}
      />
    );
  }
  return <WebhookHealthBadge health="ok" />;
}
