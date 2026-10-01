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
