import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, hmac, safeEqual } from './crypto.js';
import { createIpAllowlist } from './ip-allowlist.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  base32Decode,
  base32Encode,
  generateTotp,
  hotp,
  otpauthUrl,
  TOTP_STEP_SECONDS,
  verifyTotp,
} from './totp.js';

const RFC_SECRET = Buffer.from('12345678901234567890');

describe('HOTP / TOTP', () => {
  it('matches the RFC 4226 HOTP test vectors', () => {
    const expected = [
      '755224', '287082', '359152', '969429', '338314',
      '254676', '287922', '162583', '399871', '520489',
    ]; // prettier-ignore
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });

  it('matches the RFC 6238 SHA-1 TOTP test vectors (8 digits)', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [t, code] of vectors) {
      expect(hotp(RFC_SECRET, Math.floor(t / TOTP_STEP_SECONDS), 8)).toBe(code);
    }
  });

  it('round-trips base32 (RFC 4648 vector)', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('accepts one step of clock drift either way, nothing more', () => {
    const secret = base32Encode(RFC_SECRET);
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
    expect(verifyTotp(secret, generateTotp(secret, now), now)).toBe(step);
    expect(verifyTotp(secret, generateTotp(secret, now - 30_000), now)).toBe(step - 1);
    expect(verifyTotp(secret, generateTotp(secret, now + 30_000), now)).toBe(step + 1);
    expect(verifyTotp(secret, generateTotp(secret, now - 90_000), now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });

  it('builds an otpauth URI authenticator apps understand', () => {
    const url = otpauthUrl('ABC', 'admin@ebalangay.local');
    expect(url).toMatch(/^otpauth:\/\/totp\/eBalangay%3Aadmin%40ebalangay\.local\?/);
    expect(url).toContain('secret=ABC');
    expect(url).toContain('issuer=eBalangay');
  });
});

describe('AES-256-GCM', () => {
  const key = Buffer.alloc(32, 3).toString('base64');

  it('round-trips and uses a fresh IV each time', () => {
    const a = encrypt(key, 'JBSWY3DPEHPK3PXP', 'totp:u1');
    const b = encrypt(key, 'JBSWY3DPEHPK3PXP', 'totp:u1');
    expect(a).not.toBe(b);
    expect(decrypt(key, a, 'totp:u1')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('rejects a ciphertext moved to another row (AAD) or tampered with', () => {
    const c = encrypt(key, 'secret', 'totp:u1');
    expect(() => decrypt(key, c, 'totp:u2')).toThrow();
    const parts = c.split('.');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decrypt(key, parts.join('.'), 'totp:u1')).toThrow();
    expect(() => decrypt(Buffer.alloc(32, 4).toString('base64'), c, 'totp:u1')).toThrow();
  });
});

describe('hashing helpers', () => {
  it('hmac is keyed and safeEqual compares exactly', () => {
    expect(hmac('k1', 'x')).not.toBe(hmac('k2', 'x'));
    expect(safeEqual(hmac('k', 'x'), hmac('k', 'x'))).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('scrypt password hashes verify and never store the password', async () => {
    const h = await hashPassword('Correct Horse 9!');
    expect(h).toMatch(/^scrypt\$32768\$8\$3\$/);
    expect(h).not.toContain('Correct');
    await expect(verifyPassword('Correct Horse 9!', h)).resolves.toBe(true);
    await expect(verifyPassword('correct horse 9!', h)).resolves.toBe(false);
    await expect(verifyPassword('x', 'garbage')).resolves.toBe(false);
  });
});

describe('admin IP allowlist', () => {
  it('matches single IPs and CIDRs, including IPv4-mapped IPv6', () => {
    const allowed = createIpAllowlist(['203.0.113.7', '10.0.0.0/8', '2001:db8::/32']);
    expect(allowed('203.0.113.7')).toBe(true);
    expect(allowed('10.200.1.1')).toBe(true);
    expect(allowed('::ffff:10.1.2.3')).toBe(true);
    expect(allowed('2001:db8::1')).toBe(true);
    expect(allowed('203.0.113.8')).toBe(false);
    expect(allowed('not-an-ip')).toBe(false);
  });

  it('allows everything when empty (dev) and rejects malformed config', () => {
    expect(createIpAllowlist([])('1.2.3.4')).toBe(true);
    expect(() => createIpAllowlist(['10.0.0.0/8', 'nope'])).toThrow(/invalid entry "nope"/);
  });
});
