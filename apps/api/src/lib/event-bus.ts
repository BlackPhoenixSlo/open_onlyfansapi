// In-process event fan-out: the event source publishes, client sockets subscribe. One gateway process (plan-v4 §1.3).

/** One event as clients see it; `envelope()` from lib/signature.ts turns it into the wire frame. */
export type GatewayEvent = { id: string; type: string; createdAt: Date; accountId: number | null; data: unknown };

const listeners = new Set<(e: GatewayEvent) => void>();

/** Calls every listener synchronously; a throwing listener is logged and never stops the others. */
export function publish(e: GatewayEvent): void {
  for (const fn of [...listeners]) {
    try {
      fn(e);
    } catch (err) {
      console.error('event-bus listener failed', { eventId: e.id, type: e.type }, err);
    }
  }
}

/** Returns the unsubscribe function. */
export function subscribe(fn: (e: GatewayEvent) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
