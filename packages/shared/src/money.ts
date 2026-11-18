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

/** Integer division by a positive denominator, rounding half away from zero. */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const n = numerator < 0n ? -numerator : numerator;
  const q = (n * 2n + denominator) / (denominator * 2n);
  return numerator < 0n ? -q : q;
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
  const leftover = Number(abs - parts.reduce((a, b) => a + b, 0n));
  // leftover < weights.length, so the parts with the largest remainders get one extra centavo.
  const bonus = new Set(
    weights
      .map((w, i) => ({ i, r: (abs * BigInt(w)) % tw }))
      .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1))
      .slice(0, leftover)
      .map((o) => o.i),
  );
  return parts.map((p, i) => Number((p + (bonus.has(i) ? 1n : 0n)) * sign));
}

export function subtractCentavos(a: Centavos, b: Centavos): Centavos {
  assertCentavos(b);
  return addCentavos(a, -b);
}

/**
 * amount x percent / 100, rounded half-up. `percent` may have up to 2 decimals (12.5, 0.25);
 * it is converted to basis points without float error.
 */
export function percentOf(amount: Centavos, percent: number): Centavos {
  const bps = Math.round(percent * 100);
  if (!Number.isFinite(percent) || Math.abs(bps - percent * 100) > 1e-6) {
    throw new MoneyError(`Percent must have at most 2 decimals: ${percent}`);
  }
  return applyBasisPoints(amount, bps);
}

/** "1234.50" style string for forms and CSV. Exact: no float division. */
export function centavosToPesos(amount: Centavos): string {
  assertCentavos(amount);
  const abs = Math.abs(amount);
  const cents = String(abs % 100).padStart(2, '0');
  return `${amount < 0 ? '-' : ''}${Math.floor(abs / 100)}.${cents}`;
}

/**
 * Display only, e.g. 123450 -> "₱1,234.50", -5 -> "-₱0.05". Deterministic on every runtime
 * (Hermes Intl support varies). Never feed the result back into calculations.
 */
export function formatCentavos(amount: Centavos, opts: { symbol?: boolean } = {}): string {
  const [whole = '0', cents = '00'] = centavosToPesos(Math.abs(amount)).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = opts.symbol === false ? '' : '₱';
  return `${amount < 0 ? '-' : ''}${symbol}${grouped}.${cents}`;
}
