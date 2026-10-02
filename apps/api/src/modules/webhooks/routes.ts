import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createWebhookBody,
  deliveryStatus,
  updateWebhookBody,
  WEBHOOK_EVENTS,
  webhookDelivery,
  webhookDeliveryList,
  webhookEndpoint,
  webhookEndpointList,
  webhookEventList,
  type WebhookEventType,
} from '../../contracts.js';
import { assertWriteScope } from '../../plugins/actor.js';
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

/** Webhook endpoints and their deliveries (API key or dashboard session; writes need write scope). Mounted under /v1. */
export default async function webhooksRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('preHandler', async (request) => assertWriteScope(request.actor, request.method));
  const params = z.object({ id: z.string() });
  const tags = ['webhooks'];
  const endpointBody = z.object({ endpoint: webhookEndpoint });
  const deliveryBody = z.object({ delivery: webhookDelivery });

  r.get('/webhooks', { schema: { tags, response: { 200: webhookEndpointList } } }, async (request) => ({
    items: await listEndpoints(request.actor.teamId),
  }));

  r.post('/webhooks', { schema: { tags, body: createWebhookBody, response: { 201: endpointBody } } }, async (request, reply) => {
    const endpoint = await createEndpoint(request.actor.teamId, request.body);
    return reply.status(201).send({ endpoint });
  });

  r.get('/webhooks/events', { schema: { tags, response: { 200: webhookEventList } } }, async () => ({
    items: Object.entries(WEBHOOK_EVENTS).map(([type, description]) => ({ type: type as WebhookEventType, description })),
  }));

  r.get('/webhooks/:id', { schema: { tags, params, response: { 200: endpointBody } } }, async (request) => ({
    endpoint: await getEndpoint(request.actor.teamId, request.params.id),
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
