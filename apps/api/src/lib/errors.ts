import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import type { ErrorBody } from '../contracts.js';

/** A gateway-generated error. Rendered as `{ error: { code, message, requestId } }`. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 403 `owner_only`: a team member asked for something that is the workspace owner's (and API keys'). */
export const ownerOnly = () => new AppError(403, 'owner_only', 'This route is for the workspace owner, not team members');

/** `@fastify/rate-limit`'s `errorResponseBuilder`: 429 `rate_limited`. */
export const rateLimited = (_request: FastifyRequest, ctx: { max: number; after: string }) =>
  new AppError(429, 'rate_limited', `Rate limit of ${ctx.max} requests per minute exceeded; retry in ${ctx.after}`);

/** The driver's cause only, for logging a failed query: drizzle's own error message embeds the query parameters (fan message text). */
export const cause = (err: unknown) => (err instanceof Error && err.cause instanceof Error ? err.cause : err);

const CODE_BY_STATUS: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
};

export function errorBody(code: string, message: string, requestId: string): ErrorBody {
  return { error: { code, message, requestId } };
}

export function errorHandler(err: FastifyError | AppError, request: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) {
    return reply.status(err.statusCode).send(errorBody(err.code, err.message, request.id));
  }
  if (hasZodFastifySchemaValidationErrors(err)) {
    const detail = err.validation.map((v) => `${v.instancePath || '/'} ${v.message}`).join('; ');
    return reply.status(400).send(errorBody('validation_error', detail, request.id));
  }
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  if (status >= 500) {
    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send(errorBody('internal_error', 'Internal server error', request.id));
  }
  return reply.status(status).send(errorBody(CODE_BY_STATUS[status] ?? 'error', err.message, request.id));
}

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply) {
  return reply.status(404).send(errorBody('not_found', `Route ${request.method} ${request.url.split('?')[0]} not found`, request.id));
}
