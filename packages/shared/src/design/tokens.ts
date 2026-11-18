/**
 * Design tokens: the single source for ui-native (NativeWind) and ui-web (Tailwind).
 * Plain values only, so they work in tailwind configs, RN StyleSheets and charts.
 */
export const palette = {
  brand: {
    50: '#E1F5EE', // light
    300: '#5DCAA5', // mid
    500: '#1D9E75', // primary
    600: '#178462',
    800: '#085041', // dark teal
  },
  amber: {
    50: '#FAEEDA', // amber light
    500: '#BA7517',
    700: '#8A560F',
  },
  neutral: {
    0: '#FFFFFF',
    50: '#F7F8F8',
    100: '#EEF0F0',
    200: '#DDE1E1',
    300: '#C2C8C8',
    400: '#9AA3A3',
    500: '#6F7979',
    600: '#535C5C',
    700: '#3B4242',
    800: '#252A2A',
    900: '#161919',
    950: '#0C0E0E',
  },
  red: { 50: '#FDECEC', 500: '#D93A3A', 700: '#A62828' },
  blue: { 50: '#E8F1FC', 500: '#2F74D0', 700: '#1F519A' },
} as const;

/** Semantic roles per color scheme. Components use these, not raw palette values. */
export const semanticColors = {
  light: {
    background: palette.neutral[0],
    surface: palette.neutral[50],
    surfaceMuted: palette.neutral[100],
    border: palette.neutral[200],
    text: palette.neutral[900],
    textMuted: palette.neutral[500],
    primary: palette.brand[500],
    primaryForeground: palette.neutral[0],
    primarySoft: palette.brand[50],
    accent: palette.amber[500],
    accentSoft: palette.amber[50],
    danger: palette.red[500],
    dangerSoft: palette.red[50],
    info: palette.blue[500],
    infoSoft: palette.blue[50],
    focus: palette.brand[300],
  },
  dark: {
    background: palette.neutral[950],
    surface: palette.neutral[900],
    surfaceMuted: palette.neutral[800],
    border: palette.neutral[700],
    text: palette.neutral[50],
    textMuted: palette.neutral[400],
    primary: palette.brand[300],
    primaryForeground: palette.brand[800],
    primarySoft: palette.brand[800],
    accent: palette.amber[50],
    accentSoft: palette.amber[700],
    danger: palette.red[500],
    dangerSoft: palette.red[700],
    info: palette.blue[500],
    infoSoft: palette.blue[700],
    focus: palette.brand[300],
  },
} as const;
export type ColorScheme = keyof typeof semanticColors;
export type SemanticColor = keyof (typeof semanticColors)['light'];

/** px */
export const spacing = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const;

/** px */
export const radius = { none: 0, sm: 6, md: 10, lg: 14, xl: 20, full: 9999 } as const;

/** [fontSize, lineHeight] in px */
export const typography = {
  xs: [12, 16],
  sm: [14, 20],
  base: [16, 24],
  lg: [18, 26],
  xl: [20, 28],
  '2xl': [24, 32],
  '3xl': [30, 38],
} as const;

export const fontWeight = { regular: '400', medium: '500', semibold: '600', bold: '700' } as const;

/** Minimum touch target (WCAG / platform guidelines). */
export const MIN_TOUCH_TARGET = 44;
