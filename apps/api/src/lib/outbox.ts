import type { SocketEvent } from '@ebalangay/shared';
import type { Tx } from '../db.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { OutboxPush } from '../modules/notifications/payload.js';

export interface OutboxEventInput {
  event: SocketEvent;
  /** e.g. order, subscription_order */
  aggregateType: string;
  aggregateId: string;
  version: number;
  data: Record<string, unknown>;
  rooms: string[];
  push?: OutboxPush;
  occurredAt?: Date;
}

/** Written in the caller's transaction; the relay worker delivers it after commit. */
export async function writeEvent(tx: Tx, e: OutboxEventInput): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      event: e.event,
      aggregateType: e.aggregateType,
      aggregateId: e.aggregateId,
      version: e.version,
      payload: {
        id: e.aggregateId,
        version: e.version,
        occurredAt: (e.occurredAt ?? new Date()).toISOString(),
        data: e.data,
      } as Prisma.InputJsonValue,
      rooms: [...new Set(e.rooms)],
      ...(e.push && e.push.userIds.length ? { push: e.push as Prisma.InputJsonValue } : {}),
    },
  });
}
