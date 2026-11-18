import type { Env } from '../env.js';

export interface SmsSender {
  /** `phone` is E.164 (+639...). Throws on delivery failure. */
  send(phone: string, message: string): Promise<void>;
}

/**
 * Development only (env validation forbids it in production): prints the SMS to stdout so you
 * can sign in without a Semaphore account. It bypasses the logger on purpose; OTPs never go to logs.
 */
export class ConsoleSms implements SmsSender {
  async send(phone: string, message: string): Promise<void> {
    process.stdout.write(`\n[sms:console] to ${phone}: ${message}\n\n`);
  }
}

/** Keeps messages in memory. Tests read OTP codes from here. */
export class MemorySms implements SmsSender {
  readonly sent: { phone: string; message: string }[] = [];
  async send(phone: string, message: string): Promise<void> {
    this.sent.push({ phone, message });
  }
  lastCodeFor(phone: string): string | undefined {
    const msg = [...this.sent].reverse().find((m) => m.phone === phone)?.message;
    return msg?.match(/\b(\d{6})\b/)?.[1];
  }
}

/** https://semaphore.co/docs — the dedicated OTP route uses priority routing. */
export class SemaphoreSms implements SmsSender {
  constructor(
    private readonly apiKey: string,
    private readonly senderName: string,
    private readonly endpoint = 'https://api.semaphore.co/api/v4/priority',
  ) {}

  async send(phone: string, message: string): Promise<void> {
    const body = new URLSearchParams({
      apikey: this.apiKey,
      number: phone.replace(/^\+/, ''),
      message,
      sendername: this.senderName,
    });
    const res = await fetch(this.endpoint, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Never include the request (it carries the API key and the code).
      throw new Error(`Semaphore responded ${res.status}`);
    }
  }
}

export function createSmsSender(env: Env): SmsSender {
  if (env.SMS_DRIVER === 'semaphore') {
    // env validation already requires the key for this driver.
    if (!env.SEMAPHORE_API_KEY) throw new Error('SEMAPHORE_API_KEY is required');
    return new SemaphoreSms(env.SEMAPHORE_API_KEY, env.SEMAPHORE_SENDER_NAME);
  }
  return new ConsoleSms();
}
