import type { ServerResponse } from 'node:http';
import { desc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DashboardFrame, GatewayEvent } from '../../contracts.js';
import { db } from '../../db/index.js';
import { event } from '../../db/schema.js';
import { subscribe, subscribeDeliveries } from '../../lib/event-bus.js';
import { newId } from '../../lib/ids.js';
import { isTeamLinked } from '../../lib/team-link.js';

export type StreamOptions = {
  /** Keepalive comment interval. */
  heartbeatMs?: number;
  /**
   * Each stream's lifetime, checked on the keepalive tick: EventSource then reconnects through requireSession, which
   * re-checks the session, and the workspace link is checked again.
   */
  maxMs?: number;
};

/** How many ledger rows `GET /api/webhooks/stream/recent` returns: the Live events card keeps as many. */
const RECENT_EVENTS = 50;

type Listener = {
  teamId: string;
  /** The workspace link as of connect: only linked workspaces get upstream events. */
  linked: boolean;
  res: ServerResponse;
  heartbeat: NodeJS.Timeout;
};

/**
 * `GET /api/webhooks/stream`: Server-Sent Events of the session workspace's webhook deliveries and upstream events
 * (no replay), fed by the event bus. `GET /api/webhooks/stream/recent` returns the newest ledger events instead, without
 * payloads, so the Live events card opens with history. `POST /api/webhooks/stream/test` pushes one synthetic
 * `webhook.test` event to the caller's workspace. The open streams live in this plugin's closure: one registry per app.
 */
export default async function webhookStreamRoutes(app: FastifyInstance, opts: StreamOptions) {
  const { heartbeatMs = 25_000, maxMs = 10 * 60_000 } = opts;
  const listeners = new Set<Listener>();

  function write(l: Listener, chunk: string) {
    if (!l.res.writableEnded && !l.res.destroyed) l.res.write(chunk);
  }

  function drop(l: Listener) {
    clearInterval(l.heartbeat);
    listeners.delete(l);
    if (!l.res.writableEnded) l.res.end();
  }

  /** Sends one frame to the open streams that `to` accepts. */
  function send(frame: DashboardFrame, to: (l: Listener) => boolean) {
    const chunk = `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
    for (const l of listeners) if (to(l)) write(l, chunk);
  }

  const unsubscribe = [
    subscribe((e) => send({ event: 'event', data: e }, (l) => l.linked)),
    // The worker claims deliveries of enabled endpoints, and emit() queues only for endpoints whose events filter
    // matches, so a delivery needs no filter beyond its workspace.
    subscribeDeliveries((d) => send({ event: 'delivery', data: d.notice }, (l) => l.teamId === d.teamId)),
  ];

  app.addHook('preClose', async () => {
    for (const off of unsubscribe) off();
    for (const l of [...listeners]) drop(l);
  });

  app.get('/webhooks/stream', { preHandler: app.requireSession }, async (request, reply) => {
    const { teamId } = request.session;
    const linked = await isTeamLinked(teamId);
    reply.hijack();
    if (request.socket.destroyed) return; // gone during the link check
    const res = reply.raw;
    res.on('error', () => {}); // a write racing a dropped connection must not become an uncaught exception
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    res.write(': ready\n\n');
    const closeAt = Date.now() + maxMs;
    const listener: Listener = {
      teamId,
      linked,
      res,
      heartbeat: setInterval(() => (Date.now() >= closeAt ? drop(listener) : write(listener, ': ping\n\n')), heartbeatMs),
    };
    listeners.add(listener);
    res.on('close', () => drop(listener));
  });

  // The ledger has no team id; like the stream, every linked workspace sees every upstream event.
  app.get('/webhooks/stream/recent', { preHandler: app.requireSession }, async (request) => {
    if (!(await isTeamLinked(request.session.teamId))) return { events: [] };
    const rows = await db.select().from(event).orderBy(desc(event.createdAt), desc(event.id)).limit(RECENT_EVENTS);
    const events: GatewayEvent[] = rows.map((r) => ({
      id: r.id,
      type: r.type,
      accountId: r.accountId,
      ts: r.createdAt.toISOString(),
      data: null,
    }));
    return { events };
  });

  app.post('/webhooks/stream/test', { preHandler: app.requireSession }, async (request, reply) => {
    const e: GatewayEvent = {
      id: newId('evt'),
      type: 'webhook.test',
      accountId: null,
      ts: new Date().toISOString(),
      data: { message: 'Test event from the gateway' },
    };
    send({ event: 'event', data: e }, (l) => l.teamId === request.session.teamId);
    return reply.status(202).send({ event: e });
  });
}
