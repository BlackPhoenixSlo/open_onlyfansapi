import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { DeliveryNotice } from '../../contracts.js';
import type { Claimed } from './worker.js';

/**
 * Keepalive comment interval, and each stream's lifetime (checked on the keepalive tick): EventSource then reconnects
 * through requireSession, which re-checks the session. Mutable for tests only.
 */
export const streamTimings = { heartbeatMs: 25_000, maxMs: 10 * 60_000 };

type Listener = { teamId: string; res: ServerResponse; heartbeat: NodeJS.Timeout };

/** Open dashboard streams, each tagged with its session's workspace. */
const listeners = new Set<Listener>();

function write(l: Listener, chunk: string) {
  if (!l.res.writableEnded && !l.res.destroyed) l.res.write(chunk);
}

function drop(l: Listener) {
  clearInterval(l.heartbeat);
  listeners.delete(l);
  if (!l.res.writableEnded) l.res.end();
}

const NOTICE_STATUS = { succeeded: 'delivered', pending: 'retrying', failed: 'failed' } as const;

/**
 * Sends a finished attempt to the open streams of the endpoint's workspace only. The worker claims deliveries of
 * enabled endpoints, and emit() queues only for endpoints whose events filter matches, so this needs no filter of its own.
 */
export function notifyDelivery(
  c: Pick<Claimed, 'id' | 'teamId' | 'endpointId' | 'eventType' | 'url' | 'description'>,
  outcome: { statusCode: number | null; error: string | null },
  status: keyof typeof NOTICE_STATUS,
): void {
  const notice: DeliveryNotice = {
    deliveryId: c.id,
    endpointId: c.endpointId,
    eventType: c.eventType,
    url: c.url,
    description: c.description,
    status: NOTICE_STATUS[status],
    ...outcome,
  };
  const frame = `event: delivery\ndata: ${JSON.stringify(notice)}\n\n`;
  for (const l of listeners) if (l.teamId === c.teamId) write(l, frame);
}

/** `GET /api/webhooks/stream`: Server-Sent Events of the session workspace's webhook deliveries (no replay). */
export default async function webhookStreamRoutes(app: FastifyInstance) {
  app.addHook('preClose', async () => {
    for (const l of [...listeners]) drop(l);
  });

  app.get('/webhooks/stream', { preHandler: app.requireSession }, (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.on('error', () => {}); // a write racing a dropped connection must not become an uncaught exception
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    res.write(': ready\n\n');
    const { heartbeatMs, maxMs } = streamTimings;
    const closeAt = Date.now() + maxMs;
    const listener: Listener = {
      teamId: request.session.teamId,
      res,
      heartbeat: setInterval(() => (Date.now() >= closeAt ? drop(listener) : write(listener, ': ping\n\n')), heartbeatMs),
    };
    listeners.add(listener);
    res.on('close', () => drop(listener));
  });
}
