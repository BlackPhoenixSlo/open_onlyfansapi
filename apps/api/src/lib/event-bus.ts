// In-process fan-out: the event source and the webhook worker publish; client sockets and dashboard streams subscribe.
// One gateway process (plan-v4 §1.3).
import type { DeliveryNotice, GatewayEvent } from '../contracts.js';

/** A finished webhook delivery attempt, for the open dashboard streams of the endpoint's workspace. */
export type DeliveryMessage = { teamId: string; notice: DeliveryNotice };

/** One topic. Listeners are called synchronously; a throwing listener is logged and never stops the others. */
function topic<M>(context: (m: M) => object) {
  const listeners = new Set<(m: M) => void>();
  return {
    publish(m: M): void {
      for (const fn of [...listeners]) {
        try {
          fn(m);
        } catch (err) {
          console.error('event-bus listener failed', context(m), err);
        }
      }
    },
    /** Returns the unsubscribe function. */
    subscribe(fn: (m: M) => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** Upstream events, for every linked workspace. */
export const { publish, subscribe } = topic<GatewayEvent>((e) => ({ eventId: e.id, type: e.type }));

/** Finished delivery attempts, each for one workspace. */
export const { publish: publishDelivery, subscribe: subscribeDeliveries } = topic<DeliveryMessage>((d) => ({
  deliveryId: d.notice.deliveryId,
}));
