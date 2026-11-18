import { type ColorScheme, semanticColors } from '@ebalangay/shared/design';
import { useColorScheme } from 'react-native';

/** Raw hex colors for props that can't take classNames (Switch, ActivityIndicator, maps). */
export function useThemeColors(): (typeof semanticColors)[ColorScheme] {
  return semanticColors[useColorScheme() === 'dark' ? 'dark' : 'light'];
}

/** Keep targets at least 44x44 even when the visual is smaller. */
export const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;
