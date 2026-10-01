import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { deleteExpiredLogs } from './retention.js';

const HOUR_MS = 3_600_000;

/** In-process interval jobs (only when RUN_JOBS=true). Each runs once at start, then on its interval; stopped on close. */
export function registerJobs(app: FastifyInstance) {
  const jobs = [{ name: 'retention', everyMs: HOUR_MS, run: () => deleteExpiredLogs(env.LOG_RETENTION_DAYS) }];
  const timers = jobs.map((job) => {
    const tick = () => {
      job.run().then(
        (result) => app.log.info({ job: job.name, result }, 'job done'),
        (err) => app.log.error({ err, job: job.name }, 'job failed'),
      );
    };
    setImmediate(tick).unref();
    return setInterval(tick, job.everyMs).unref();
  });
  app.addHook('onClose', async () => timers.forEach(clearInterval));
}
