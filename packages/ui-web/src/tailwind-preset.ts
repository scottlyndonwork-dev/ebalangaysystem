import { palette, radius, spacing, typography } from '@ebalangay/shared/design';

const px = (obj: Record<string | number, number>) =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, `${v}px`]));

/**
 * JS preset for tooling that wants a config object (e.g. `@config` in Tailwind v4, Storybook).
 * Semantic colors come from the CSS variables in styles.css so dark mode works.
 */
export const tailwindPreset = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: palette.brand,
        amber: palette.amber,
        neutral: palette.neutral,
        background: 'var(--background)',
        foreground: 'var(--text)',
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
          soft: 'var(--primary-soft)',
        },
        muted: { DEFAULT: 'var(--surface-muted)', foreground: 'var(--text-muted)' },
        accent: { DEFAULT: 'var(--accent)', soft: 'var(--accent-soft)' },
        danger: { DEFAULT: 'var(--danger)', soft: 'var(--danger-soft)' },
        info: { DEFAULT: 'var(--info)', soft: 'var(--info-soft)' },
        border: 'var(--border)',
        ring: 'var(--focus)',
      },
      spacing: px(spacing),
      borderRadius: px(radius),
      fontSize: Object.fromEntries(
        Object.entries(typography).map(([k, [size, line]]) => [k, [`${size}px`, `${line}px`]]),
      ),
    },
  },
} as const;

export default tailwindPreset;
