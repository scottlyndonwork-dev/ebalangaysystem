import { deviceSchema, ErrorCode, registerDeviceInputSchema, userSchema } from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { authOf, requireAuth } from '../../plugins/auth.js';
import { appFromDb, appToDb, toUserDto } from '../auth/schemas.js';

const tags = ['me'];

/** /v1/me/* : the signed-in user's own profile and devices. */
export async function meRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', requireAuth);

  r.get('/', { schema: { tags, response: { 200: userSchema } } }, async (req) => {
    const user = await app.db.user.findUnique({ where: { id: authOf(req).userId } });
    if (!user || user.status !== 'active') {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Sign in required');
    }
    return toUserDto(user);
  });

  /** Called on every app start and whenever the Expo push token changes. Idempotent. */
  r.post(
    '/devices',
    { schema: { tags, body: registerDeviceInputSchema, response: { 200: deviceSchema } } },
    async (req) => {
      const userId = authOf(req).userId;
      const { deviceId, platform, app: appPlatform, pushToken, appVersion } = req.body;
      const device = await app.db.$transaction(async (tx) => {
        if (pushToken) {
          // A push token identifies one install; it can't keep notifying a previous user.
          await tx.userDevice.updateMany({
            where: { pushToken, NOT: { userId, deviceId } },
            data: { pushToken: null },
          });
        }
        const fields = {
          platform,
          app: appToDb(appPlatform),
          lastSeenAt: new Date(),
          ...(pushToken !== undefined ? { pushToken } : {}),
          ...(appVersion !== undefined ? { appVersion } : {}),
        };
        return tx.userDevice.upsert({
          where: { userId_deviceId: { userId, deviceId } },
          update: fields,
          create: { userId, deviceId, ...fields },
        });
      });
      return {
        deviceId: device.deviceId,
        platform: device.platform,
        app: appFromDb(device.app),
        hasPushToken: device.pushToken !== null,
        lastSeenAt: device.lastSeenAt.toISOString(),
      };
    },
  );

  r.delete(
    '/devices/:deviceId',
    { schema: { tags, params: z.object({ deviceId: z.string().min(1).max(128) }) } },
    async (req, reply) => {
      await app.db.userDevice.deleteMany({
        where: { userId: authOf(req).userId, deviceId: req.params.deviceId },
      });
      return reply.status(204).send();
    },
  );
}
