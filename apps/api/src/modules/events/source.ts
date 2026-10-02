import type { FastifyBaseLogger } from 'fastify';

/** The upstream event socket consumer (plan-v4 Phase 1). Stub: opens nothing until Phase 1 replaces it. */
export function startEventSource(_log: FastifyBaseLogger): { stop: () => Promise<void> } {
  return { stop: async () => {} };
}
