import { appVersionSchema, compareVersions, ErrorCode, Headers } from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../lib/errors.js';

/**
 * Mobile apps send X-App-Version. Below MIN_APP_VERSION they get 426 so the app can force-update.
 * Requests without the header (web apps, webhooks, health checks) pass through.
 */
export function registerAppVersionCheck(app: FastifyInstance, minVersion: string): void {
  app.addHook('onRequest', async (req) => {
    const raw = req.headers[Headers.APP_VERSION];
    if (raw === undefined) return;
    const parsed = appVersionSchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid X-App-Version header');
    }
    if (compareVersions(parsed.data, minVersion) < 0) {
      throw new AppError(ErrorCode.UPGRADE_REQUIRED, 'App update required', { minVersion });
    }
  });
}
