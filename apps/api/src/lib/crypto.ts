import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** HMAC-SHA256, hex. Used for OTP codes and refresh tokens so a DB leak reveals neither. */
export function hmac(key: string, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

/** Constant-time comparison of two hex/ASCII strings. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** URL-safe random token with 256 bits of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const VERSION = 'v1';

/**
 * AES-256-GCM with a random 96-bit IV. Output: "v1.ivB64.tagB64.cipherB64".
 * `aad` binds the ciphertext to its owner (e.g. the user id) so it can't be swapped between rows.
 */
export function encrypt(keyB64: string, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const b64 = (b: Buffer) => b.toString('base64');
  return [VERSION, b64(iv), b64(cipher.getAuthTag()), b64(data)].join('.');
}

export function decrypt(keyB64: string, payload: string, aad: string): string {
  const [version, iv, tag, data] = payload.split('.');
  if (version !== VERSION || !iv || !tag || !data) throw new Error('Unsupported ciphertext');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(keyB64, 'base64'),
    Buffer.from(iv, 'base64'),
  );
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}
