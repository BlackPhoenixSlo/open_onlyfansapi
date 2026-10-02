import type { WebhookEndpoint } from '@api/contracts';
import { Badge } from '@/components/ui/badge';

/** ok / failing / paused, from `enabled`, `pausedReason` and `consecutiveFailures`. */
export function WebhookHealth({ endpoint }: { endpoint: WebhookEndpoint }) {
  if (!endpoint.enabled) {
    return endpoint.pausedReason === 'failures' ? (
      <Badge variant="destructive" title={`Paused after ${endpoint.consecutiveFailures} failed deliveries`}>
        paused (failures)
      </Badge>
    ) : (
      <Badge variant="secondary" title="Paused manually">
        paused
      </Badge>
    );
  }
  if (endpoint.consecutiveFailures > 0) {
    return (
      <Badge
        className="bg-amber-500/15 text-amber-700 dark:text-amber-400"
        title={`${endpoint.consecutiveFailures} failed deliveries since the last success`}
      >
        failing
      </Badge>
    );
  }
  return <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">ok</Badge>;
}
