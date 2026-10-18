import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { apiKey, createdKey, createKeyBody, keyList, updateKeyBody } from '../../contracts.js';
import { createKey, listKeys, revokeKey, updateKey } from './service.js';

/** Dashboard-only key management (session cookie). Mounted at /api/keys. */
export default async function keysRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('preHandler', app.requireOwner);
  const params = z.object({ id: z.string() });
  const tags = ['dashboard'];

  r.get('/', { schema: { tags, response: { 200: keyList } } }, async (request) => ({
    items: await listKeys(request.session.teamId),
  }));

  r.post('/', { schema: { tags, body: createKeyBody, response: { 201: createdKey } } }, async (request, reply) => {
    const created = await createKey(request.session.teamId, request.session.userId, request.body);
    return reply.status(201).send(created);
  });

  r.patch(
    '/:id',
    { schema: { tags, params, body: updateKeyBody, response: { 200: z.object({ key: apiKey }) } } },
    async (request) => ({ key: await updateKey(request.session.teamId, request.params.id, request.body) }),
  );

  r.delete('/:id', { schema: { tags, params } }, async (request, reply) => {
    await revokeKey(request.session.teamId, request.params.id);
    return reply.status(204).send();
  });
}
