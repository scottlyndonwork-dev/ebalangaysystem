import * as Sentry from '@sentry/node';
import type { Env } from '../env.js';
import { API_VERSION } from '../version.js';

/** Call once at process start, before the app is built. No-op without SENTRY_DSN. */
export function initSentry(env: Env): void {
  if (!env.SENTRY_DSN) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    release: API_VERSION,
    // Strip anything that could carry tokens, OTPs or card data.
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        if (event.request.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
      }
      return event;
    },
  });
}
