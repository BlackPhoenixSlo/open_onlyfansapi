import type { FastifyBaseLogger } from 'fastify';
import { env } from '../../env.js';
import { createIngestQueue, parseFrame } from './ingest.js';

/** Reconnect backoff and the no-frame window; overridable for tests only. */
export type SourceTimings = { backoffMinMs: number; backoffMaxMs: number; staleMs: number };
const TIMINGS: SourceTimings = { backoffMinMs: 1000, backoffMaxMs: 60_000, staleMs: 90_000 };

let current: { stop: () => Promise<void> } | null = null;

/**
 * The single upstream event socket (`UPSTREAM_WS_URL`; unset = nothing opened). Reconnects with jittered backoff
 * (reset on the first frame of a connection) and when no frame (heartbeats included) arrives within the stale window.
 * `stop()` closes the socket, clears every timer and waits for queued frames to be ingested.
 */
export function startEventSource(log: FastifyBaseLogger, timings: SourceTimings = TIMINGS): { stop: () => Promise<void> } {
  const url = env.UPSTREAM_WS_URL;
  if (!url) return { stop: async () => {} };
  if (current) {
    log.warn('upstream event source already running; not starting another');
    return current;
  }
  const protocols = ['bearer', `bearer.${env.UPSTREAM_TOKEN}`];
  const queue = createIngestQueue(log);
  let socket: WebSocket | null = null;
  let stopped = false;
  let backoff = timings.backoffMinMs;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let staleTimer: NodeJS.Timeout | undefined;

  /** Forgets the socket (its late events are ignored), closes it and schedules the next connect. */
  function reconnect(sock: WebSocket) {
    if (socket !== sock) return;
    socket = null;
    clearTimeout(staleTimer);
    sock.close();
    if (stopped) return;
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    backoff = Math.min(backoff * 2, timings.backoffMaxMs);
    reconnectTimer = setTimeout(connect, delay);
  }

  function armStale(sock: WebSocket) {
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      log.warn({ staleMs: timings.staleMs }, 'upstream event socket silent; reconnecting');
      reconnect(sock);
    }, timings.staleMs);
  }

  function connect() {
    const sock = new WebSocket(url!, protocols);
    socket = sock;
    let first = true;
    armStale(sock); // also bounds a handshake that never completes
    sock.onopen = () => log.info('upstream event socket connected');
    sock.onmessage = (ev) => {
      if (socket !== sock) return;
      armStale(sock);
      if (first) {
        first = false;
        backoff = timings.backoffMinMs;
      }
      if (typeof ev.data !== 'string') {
        log.warn('upstream event frame is binary; dropped');
        return;
      }
      const frame = parseFrame(ev.data, log);
      if (frame && frame !== 'heartbeat') queue.push(frame);
    };
    sock.onclose = (ev) => {
      if (socket !== sock) return;
      log.warn({ code: ev.code, reason: ev.reason }, 'upstream event socket closed; reconnecting');
      reconnect(sock);
    };
    // An error is always followed by a close event.
    sock.onerror = () => {};
  }

  connect();
  const handle = {
    stop: async () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      if (socket) reconnect(socket);
      if (current === handle) current = null;
      await queue.idle();
    },
  };
  current = handle;
  return handle;
}
