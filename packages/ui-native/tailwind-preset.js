// NativeWind (Tailwind 3) preset. In an app's tailwind.config.js:
//   import preset from '@ebalangay/ui-native/tailwind-preset';
//   export default { presets: [preset], content: ['./app/**/*.{ts,tsx}', '../../packages/ui-native/dist/**/*.js'] };
import { palette, radius, semanticColors, spacing, typography } from '@ebalangay/shared/design';
import nativewindPreset from 'nativewind/preset';

const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const px = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, `${v}px`]));

// `bg-primary` for light, `dark:bg-primary-dark` for dark.
const semantic = Object.fromEntries(
  Object.keys(semanticColors.light).map((key) => [
    kebab(key),
    { DEFAULT: semanticColors.light[key], dark: semanticColors.dark[key] },
  ]),
);

/** @type {import('tailwindcss').Config} */
export default {
  content: [],
  presets: [nativewindPreset],
  darkMode: 'class',
  theme: {
    extend: {
      colors: { ...semantic, brand: palette.brand, amber: palette.amber, neutral: palette.neutral },
      spacing: px(spacing),
      borderRadius: px(radius),
      fontSize: Object.fromEntries(
        Object.entries(typography).map(([k, [size, line]]) => [k, [`${size}px`, `${line}px`]]),
      ),
      minHeight: { touch: '44px' },
      minWidth: { touch: '44px' },
    },
  },
};
