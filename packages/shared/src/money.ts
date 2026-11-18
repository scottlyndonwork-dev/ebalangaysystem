/**
 * Money is always integer centavos (PHP). DB column type is BIGINT; in TS we use
 * `number` constrained to safe integers (max ~PHP 90 trillion), converted at the Prisma boundary.
 */
export type Centavos = number;

export const CURRENCY = 'PHP' as const;

export class MoneyError extends Error {
  override name = 'MoneyError';
}

export function assertCentavos(value: number): asserts value is Centavos {
  if (!Number.isSafeInteger(value)) throw new MoneyError(`Invalid centavos amount: ${value}`);
}

/** Parse a peso string like "1,234.5" or "-12.05" into centavos without float math. */
export function pesosToCentavos(input: string): Centavos {
  const s = input.trim().replace(/,/g, '');
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new MoneyError(`Invalid peso amount: "${input}"`);
  const [, sign, whole = '0', frac = ''] = m;
  const value = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  assertCentavos(value);
  return sign ? -value : value;
}

export function addCentavos(...amounts: Centavos[]): Centavos {
  let total = 0;
  for (const a of amounts) {
    assertCentavos(a);
    total += a;
  }
  assertCentavos(total);
  return total;
}

/** Integer division rounding half away from zero. */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const neg = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (d * 2n);
  return neg ? -q : q;
}

/** amount x basisPoints / 10_000 (e.g. 1250 bps = 12.5%), rounded half-up. */
export function applyBasisPoints(amount: Centavos, basisPoints: number): Centavos {
  assertCentavos(amount);
  if (!Number.isSafeInteger(basisPoints)) {
    throw new MoneyError(`Invalid basis points: ${basisPoints}`);
  }
  const result = Number(divRoundHalfUp(BigInt(amount) * BigInt(basisPoints), 10_000n));
  assertCentavos(result);
  return result;
}

export function multiplyCentavos(amount: Centavos, quantity: number): Centavos {
  assertCentavos(amount);
  if (!Number.isSafeInteger(quantity)) throw new MoneyError(`Invalid quantity: ${quantity}`);
  const result = amount * quantity;
  assertCentavos(result);
  return result;
}

/**
 * Split an amount by non-negative integer weights so parts always sum to the original.
 * Largest-remainder method; ties go to the earliest part.
 */
export function allocateCentavos(amount: Centavos, weights: number[]): Centavos[] {
  assertCentavos(amount);
  if (weights.length === 0) throw new MoneyError('allocateCentavos needs at least one weight');
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new MoneyError('Weights must be non-negative integers');
  }
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight === 0) throw new MoneyError('Weights must not all be zero');

  const sign = amount < 0 ? -1n : 1n;
  const abs = BigInt(Math.abs(amount));
  const tw = BigInt(totalWeight);
  const parts = weights.map((w) => (abs * BigInt(w)) / tw);
  let leftover = abs - parts.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((w, i) => ({ i, r: (abs * BigInt(w)) % tw }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  // leftover < weights.length, so each part gets at most one extra centavo.
  for (const { i } of order) {
    if (leftover === 0n) break;
    parts[i] = (parts[i] ?? 0n) + 1n;
    leftover--;
  }
  return parts.map((p) => Number(p * sign));
}

/** Display only. Never feed the result back into calculations. */
export function formatPHP(amount: Centavos, locale = 'en-PH'): string {
  assertCentavos(amount);
  return new Intl.NumberFormat(locale, { style: 'currency', currency: CURRENCY }).format(
    amount / 100,
  );
}
