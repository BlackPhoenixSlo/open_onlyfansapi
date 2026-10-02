import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { deleteExpiredDeliveries, deliverDue } from '../modules/webhooks/worker.js';
import { deleteExpiredLogs } from './retention.js';

const HOUR_MS = 3_600_000;

type Job = { name: string; everyMs: number; run: () => Promise<number>; /** log only runs that did something */ quiet?: boolean };

/**
 * In-process interval jobs (only when RUN_JOBS=true). Each runs once at start, then on its interval; stopped on close.
 * A tick is skipped while the job's previous run is still in flight, so slow runs never stack.
 */
export function registerJobs(app: FastifyInstance) {
  const jobs: Job[] = [
    { name: 'retention', everyMs: HOUR_MS, run: () => deleteExpiredLogs(env.LOG_RETENTION_DAYS) },
    { name: 'webhook-retention', everyMs: HOUR_MS, run: () => deleteExpiredDeliveries(env.WEBHOOK_RETENTION_DAYS) },
    { name: 'webhooks', everyMs: 1000, run: deliverDue, quiet: true },
  ];
  const timers = jobs.map((job) => {
    let running = false;
    const tick = () => {
      if (running) return;
      running = true;
      job
        .run()
        .then(
          (result) => {
            if (!job.quiet || result > 0) app.log.info({ job: job.name, result }, 'job done');
          },
          (err) => app.log.error({ err, job: job.name }, 'job failed'),
        )
        .finally(() => {
          running = false;
        });
    };
    setImmediate(tick).unref();
    return setInterval(tick, job.everyMs).unref();
  });
  app.addHook('onClose', async () => timers.forEach(clearInterval));
}
