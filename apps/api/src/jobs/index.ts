import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { startEventSource } from '../modules/events/source.js';
import { deliverDue } from '../modules/webhooks/worker.js';
import { pollTransactions } from './analytics-refresh.js';
import { deleteExpired } from './retention.js';

const HOUR_MS = 3_600_000;

/**
 * In-process interval jobs (only when RUN_JOBS=true). Each runs once at start, then on its interval; stopped on close.
 * A tick is skipped while the job's previous run is still in flight, so slow runs never stack; close waits for it.
 * With UPSTREAM_WS_URL set, also the single upstream event source, stopped on close. With STATS_REFRESH_HOUR_UTC set
 * (unset = off), also the analytics refresh: the hourly transactions poll.
 */
export function registerJobs(app: FastifyInstance) {
  const jobs = [
    { name: 'retention', everyMs: HOUR_MS, run: () => deleteExpired('request_log', env.LOG_RETENTION_DAYS) },
    { name: 'webhook-retention', everyMs: HOUR_MS, run: () => deleteExpired('webhook_delivery', env.WEBHOOK_RETENTION_DAYS) },
    { name: 'event-retention', everyMs: HOUR_MS, run: () => deleteExpired('event', env.EVENT_RETENTION_DAYS) },
    { name: 'webhooks', everyMs: 1000, run: deliverDue },
    ...(env.STATS_REFRESH_HOUR_UTC === undefined
      ? []
      : [{ name: 'transactions-poll', everyMs: HOUR_MS, run: () => pollTransactions(app.upstream, app.log) }]),
  ];
  const inFlight = new Set<Promise<void>>();
  const timers = jobs.map((job) => {
    let running = false;
    const tick = () => {
      if (running) return;
      running = true;
      const run = job
        .run()
        .then(
          (result) => {
            if (result > 0) app.log.info({ job: job.name, result }, 'job done');
          },
          (err) => app.log.error({ err, job: job.name }, 'job failed'),
        )
        .finally(() => {
          running = false;
          inFlight.delete(run);
        });
      inFlight.add(run);
    };
    setImmediate(tick).unref();
    return setInterval(tick, job.everyMs).unref();
  });
  const source = env.UPSTREAM_WS_URL ? startEventSource(app.log) : null;
  // Before the caller ends the pool: stop ticking and the event source, then let in-flight runs finish.
  app.addHook('onClose', async () => {
    timers.forEach(clearInterval);
    await source?.stop();
    await Promise.all(inFlight);
  });
}
