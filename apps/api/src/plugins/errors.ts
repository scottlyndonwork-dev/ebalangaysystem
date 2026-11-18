import { type ApiError, ErrorCode } from '@ebalangay/shared';
import * as Sentry from '@sentry/node';
import type { FastifyError, FastifyInstance } from 'fastify';
import { AppError } from '../lib/errors.js';
import { RequestValidationError } from '../lib/zod-provider.js';

function body(code: ErrorCode, message: string, requestId: string, details?: unknown): ApiError {
  return { error: { code, message, requestId, ...(details === undefined ? {} : { details }) } };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send(body(ErrorCode.NOT_FOUND, 'Route not found', req.id));
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(body(err.code, err.message, req.id, err.details));
    }
    if (err instanceof RequestValidationError || err.validation) {
      const details =
        err instanceof RequestValidationError
          ? {
              part: err.part,
              issues: err.issues.map((i) => ({ path: i.path, message: i.message })),
            }
          : undefined;
      return reply
        .status(400)
        .send(body(ErrorCode.VALIDATION_FAILED, 'Request validation failed', req.id, details));
    }
    if (err.statusCode === 429) {
      return reply.status(429).send(body(ErrorCode.RATE_LIMITED, 'Too many requests', req.id));
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      // Fastify-level client errors (bad JSON, body too large, unsupported media type).
      return reply
        .status(err.statusCode)
        .send(body(ErrorCode.VALIDATION_FAILED, err.message, req.id));
    }

    req.log.error({ err }, 'unhandled error');
    Sentry.captureException(err, { tags: { requestId: req.id } });
    return reply.status(500).send(body(ErrorCode.INTERNAL, 'Internal server error', req.id));
  });
}
