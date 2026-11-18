import type { Tone } from '@ebalangay/shared/design';
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge class names; later classes win over earlier conflicting ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Keep only digits, capped at `length`. Handles pasted codes like "123 456". */
export function sanitizeOtp(value: string, length: number): string {
  return value.replace(/\D/g, '').slice(0, length);
}

export function clampQuantity(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export type StarFill = 'full' | 'half' | 'empty';

/** Five star states for a 0-5 rating, rounded to the nearest half. */
export function starFills(rating: number, max = 5): StarFill[] {
  const r = Math.round(Math.min(max, Math.max(0, rating)) * 2) / 2;
  return Array.from({ length: max }, (_, i) =>
    r >= i + 1 ? 'full' : r >= i + 0.5 ? 'half' : 'empty',
  );
}

/** "Juan Dela Cruz" -> "JC" */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** Background + text classes per tone, light and dark. */
export const TONE_CLASSES: Record<Tone, { container: string; text: string }> = {
  neutral: {
    container: 'bg-surface-muted dark:bg-surface-muted-dark',
    text: 'text-text-muted dark:text-text-muted-dark',
  },
  info: { container: 'bg-info-soft dark:bg-info-soft-dark', text: 'text-info dark:text-info-dark' },
  warning: {
    container: 'bg-accent-soft dark:bg-accent-soft-dark',
    text: 'text-accent dark:text-accent-dark',
  },
  brand: {
    container: 'bg-primary-soft dark:bg-primary-soft-dark',
    text: 'text-primary dark:text-primary-dark',
  },
  success: {
    container: 'bg-primary dark:bg-primary-dark',
    text: 'text-primary-foreground dark:text-primary-foreground-dark',
  },
  danger: {
    container: 'bg-danger-soft dark:bg-danger-soft-dark',
    text: 'text-danger dark:text-danger-dark',
  },
};
