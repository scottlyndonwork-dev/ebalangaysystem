import { createHmac } from 'node:crypto';
import { safeEqual } from '../../lib/crypto.js';

/**
 * Public tracking token: base64url(order id bytes) + truncated HMAC (96 bits). Stateless; the
 * expiry comes from the order itself (an hour after it ends). The key is derived from the JWT
 * secret with its own label, so a tracking MAC can never pass as anything else.
 */
const ID_CHARS = 22;
const MAC_BYTES = 12;

const keyFor = (secret: string) => createHmac('sha256', secret).update('tracking-link:v1').digest();

function mac(secret: string, orderId: string): string {
  return createHmac('sha256', keyFor(secret))
    .update(orderId)
    .digest()
    .subarray(0, MAC_BYTES)
    .toString('base64url');
}

export function signTrackingToken(secret: string, orderId: string): string {
  const id = Buffer.from(orderId.replaceAll('-', ''), 'hex').toString('base64url');
  return id + mac(secret, orderId);
}

/** The order id, or null for a malformed or forged token. */
export function verifyTrackingToken(secret: string, token: string): string | null {
  if (!/^[\w-]+$/.test(token) || token.length <= ID_CHARS) return null;
  const bytes = Buffer.from(token.slice(0, ID_CHARS), 'base64url');
  if (bytes.length !== 16) return null;
  const hex = bytes.toString('hex');
  const orderId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return safeEqual(token.slice(ID_CHARS), mac(secret, orderId)) ? orderId : null;
}

/** Tracking stops an hour after the order ends. */
export const TRACKING_GRACE_MS = 60 * 60_000;
