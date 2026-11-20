import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import type { Env } from '../env.js';

export interface PushMessage {
  /** Expo push token (ExponentPushToken[...]). */
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

/** `deviceGone`: the token is dead (app uninstalled / token rotated) and should be cleared. */
export type PushOutcome =
  { ok: true; receiptId?: string } | { ok: false; error: string; deviceGone: boolean };

export interface PushSender {
  isValidToken(token: string): boolean;
  /** One outcome per message, same order. Throws only when the whole send failed (retry). */
  send(messages: PushMessage[]): Promise<PushOutcome[]>;
  /** Delivery receipts for earlier tickets; ids without a receipt yet are omitted. */
  receipts(ids: string[]): Promise<Record<string, PushOutcome>>;
}

const gone = (error: string | undefined) => error === 'DeviceNotRegistered';

/** https://docs.expo.dev/push-notifications/sending-notifications/ */
export class ExpoPush implements PushSender {
  private readonly expo: Expo;
  constructor(accessToken?: string) {
    this.expo = new Expo(accessToken ? { accessToken } : {});
  }

  isValidToken(token: string): boolean {
    return Expo.isExpoPushToken(token);
  }

  async send(messages: PushMessage[]): Promise<PushOutcome[]> {
    const out: PushOutcome[] = [];
    const expoMessages: ExpoPushMessage[] = messages.map((m) => ({
      to: m.to,
      title: m.title,
      body: m.body,
      data: m.data,
      sound: 'default',
      priority: 'high',
      channelId: 'default',
    }));
    for (const chunk of this.expo.chunkPushNotifications(expoMessages)) {
      const tickets = await this.expo.sendPushNotificationsAsync(chunk);
      for (const t of tickets) {
        out.push(
          t.status === 'ok'
            ? { ok: true, receiptId: t.id }
            : { ok: false, error: t.message, deviceGone: gone(t.details?.error) },
        );
      }
    }
    return out;
  }

  async receipts(ids: string[]): Promise<Record<string, PushOutcome>> {
    const out: Record<string, PushOutcome> = {};
    for (const chunk of this.expo.chunkPushNotificationReceiptIds(ids)) {
      const receipts = await this.expo.getPushNotificationReceiptsAsync(chunk);
      for (const [id, r] of Object.entries(receipts)) {
        out[id] =
          r.status === 'ok'
            ? { ok: true }
            : { ok: false, error: r.message, deviceGone: gone(r.details?.error) };
      }
    }
    return out;
  }
}

/** Development: prints pushes to stdout instead of calling Expo. */
export class ConsolePush implements PushSender {
  isValidToken(token: string): boolean {
    return Expo.isExpoPushToken(token);
  }
  async send(messages: PushMessage[]): Promise<PushOutcome[]> {
    for (const m of messages) process.stdout.write(`\n[push:console] ${m.title}: ${m.body}\n`);
    return messages.map(() => ({ ok: true }));
  }
  async receipts(): Promise<Record<string, PushOutcome>> {
    return {};
  }
}

/** Tests: records messages; tokens in `goneTokens` fail as DeviceNotRegistered. */
export class MemoryPush implements PushSender {
  readonly sent: PushMessage[] = [];
  readonly goneTokens = new Set<string>();
  /** Receipt id -> outcome, returned by receipts(). */
  readonly receiptOutcomes = new Map<string, PushOutcome>();
  failNext = 0;
  private seq = 0;

  isValidToken(token: string): boolean {
    return Expo.isExpoPushToken(token);
  }
  async send(messages: PushMessage[]): Promise<PushOutcome[]> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('push service unavailable');
    }
    return messages.map((m) => {
      if (this.goneTokens.has(m.to)) {
        return { ok: false, error: 'not registered', deviceGone: true };
      }
      this.sent.push(m);
      return { ok: true, receiptId: `r-${++this.seq}` };
    });
  }
  async receipts(ids: string[]): Promise<Record<string, PushOutcome>> {
    return Object.fromEntries(
      ids.flatMap((id) => {
        const r = this.receiptOutcomes.get(id);
        return r ? [[id, r]] : [];
      }),
    );
  }
}

export function createPushSender(env: Env): PushSender {
  return env.PUSH_DRIVER === 'expo' ? new ExpoPush(env.EXPO_ACCESS_TOKEN) : new ConsolePush();
}
