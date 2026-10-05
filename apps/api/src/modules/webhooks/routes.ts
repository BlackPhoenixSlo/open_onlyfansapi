import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createWebhookBody,
  deliveryStatus,
  eventStatus,
  updateWebhookBody,
  WEBHOOK_EVENTS,
  webhookDelivery,
  webhookDeliveryList,
  webhookEndpoint,
  webhookEndpointList,
  webhookEventList,
  webhookEventType,
  type WebhookEndpoint,
} from '../../contracts.js';
import { AppError } from '../../lib/errors.js';
import { assertWriteScope, type Actor } from '../../plugins/actor.js';
import {
  createEndpoint,
  deleteEndpoint,
  getEndpoint,
  listDeliveries,
  listEndpoints,
  queueTest,
  redeliver,
  updateEndpoint,
} from './service.js';

const deliveriesQuery = z.object({
  status: deliveryStatus.optional(),
  /** exact event type */
  event: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** The signing secret is shown only to actors that may write (session or write key). */
function forActor(actor: Actor, endpoint: WebhookEndpoint): WebhookEndpoint {
  if (actor.scope === 'write') return endpoint;
  const { secret: _secret, ...rest } = endpoint;
  return rest;
}

/**
 * Webhook endpoints and their deliveries (API key or dashboard session; writes need write scope). Mounted under /v1.
 * Keys limited to some accounts are refused: endpoints receive every account's events.
 */
export default async function webhooksRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('preHandler', async (request) => {
    if (request.actor.accountIds !== null) {
      throw new AppError(403, 'account_not_allowed', 'API keys limited to specific accounts cannot manage webhooks');
    }
    assertWriteScope(request.actor, request.method);
  });
  const params = z.object({ id: z.string() });
  const tags = ['webhooks'];
  const endpointBody = z.object({ endpoint: webhookEndpoint });
  const deliveryBody = z.object({ delivery: webhookDelivery });

  r.get('/webhooks', { schema: { tags, response: { 200: webhookEndpointList } } }, async (request) => ({
    items: (await listEndpoints(request.actor.teamId)).map((e) => forActor(request.actor, e)),
  }));

  r.post('/webhooks', { schema: { tags, body: createWebhookBody, response: { 201: endpointBody } } }, async (request, reply) => {
    const endpoint = await createEndpoint(request.actor.teamId, request.body);
    return reply.status(201).send({ endpoint });
  });

  r.get('/webhooks/events', { schema: { tags, response: { 200: webhookEventList } } }, async () => ({
    items: webhookEventType.options.map((type) => {
      const description = WEBHOOK_EVENTS[type];
      return { type, description, status: eventStatus(description) };
    }),
  }));

  r.get('/webhooks/:id', { schema: { tags, params, response: { 200: endpointBody } } }, async (request) => ({
    endpoint: forActor(request.actor, await getEndpoint(request.actor.teamId, request.params.id)),
  }));

  r.patch(
    '/webhooks/:id',
    { schema: { tags, params, body: updateWebhookBody, response: { 200: endpointBody } } },
    async (request) => ({ endpoint: await updateEndpoint(request.actor.teamId, request.params.id, request.body) }),
  );

  r.delete('/webhooks/:id', { schema: { tags, params } }, async (request, reply) => {
    await deleteEndpoint(request.actor.teamId, request.params.id);
    return reply.status(204).send();
  });

  r.post('/webhooks/:id/test', { schema: { tags, params, response: { 202: deliveryBody } } }, async (request, reply) => {
    const delivery = await queueTest(request.actor.teamId, request.params.id);
    return reply.status(202).send({ delivery });
  });

  r.get(
    '/webhooks/:id/deliveries',
    { schema: { tags, params, querystring: deliveriesQuery, response: { 200: webhookDeliveryList } } },
    async (request) => listDeliveries(request.actor.teamId, request.params.id, request.query),
  );

  r.post(
    '/webhooks/:id/deliveries/:deliveryId/redeliver',
    { schema: { tags, params: z.object({ id: z.string(), deliveryId: z.string() }), response: { 202: deliveryBody } } },
    async (request, reply) => {
      const delivery = await redeliver(request.actor.teamId, request.params.id, request.params.deliveryId);
      return reply.status(202).send({ delivery });
    },
  );
}
