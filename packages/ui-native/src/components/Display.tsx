import type { Tone } from '@ebalangay/shared/design';
import { Image } from 'expo-image';
import type { ReactNode } from 'react';
import { Pressable, View, type ViewProps } from 'react-native';
import { cn, initials, TONE_CLASSES } from '../lib/utils.js';
import { Text } from './Text.js';

export interface CardProps extends ViewProps {
  /** Makes the whole card a button. */
  onPress?: () => void;
  accessibilityLabel?: string;
  padded?: boolean;
  className?: string;
}

export function Card({
  onPress,
  padded = true,
  className,
  children,
  accessibilityLabel,
  ...props
}: CardProps) {
  const classes = cn(
    'overflow-hidden rounded-lg border border-border bg-background dark:border-border-dark dark:bg-surface-dark',
    padded && 'p-4',
    className,
  );
  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        className={cn(classes, 'active:opacity-80')}
      >
        {children}
      </Pressable>
    );
  }
  return (
    <View className={classes} accessibilityLabel={accessibilityLabel} {...props}>
      {children}
    </View>
  );
}

export interface BadgeProps {
  label: string;
  tone?: Tone;
  icon?: ReactNode;
  className?: string;
}

export function Badge({ label, tone = 'neutral', icon, className }: BadgeProps) {
  const t = TONE_CLASSES[tone];
  return (
    <View
      className={cn(
        'flex-row items-center gap-1 self-start rounded-full px-2 py-0.5',
        t.container,
        className,
      )}
    >
      {icon}
      <Text variant="caption" className={cn('font-semibold', t.text)}>
        {label}
      </Text>
    </View>
  );
}

const avatarSizes = { sm: 32, md: 44, lg: 64 } as const;

export interface AvatarProps {
  name: string;
  uri?: string | null;
  size?: keyof typeof avatarSizes;
  className?: string;
}

export function Avatar({ name, uri, size = 'md', className }: AvatarProps) {
  const px = avatarSizes[size];
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={name}
      style={{ width: px, height: px }}
      className={cn(
        'items-center justify-center overflow-hidden rounded-full bg-primary-soft dark:bg-primary-soft-dark',
        className,
      )}
    >
      {uri ? (
        <Image
          source={{ uri }}
          style={{ width: px, height: px }}
          contentFit="cover"
          transition={150}
        />
      ) : (
        <Text
          className={cn(
            'font-semibold text-brand-800 dark:text-brand-50',
            size === 'lg' ? 'text-xl' : 'text-sm',
          )}
        >
          {initials(name)}
        </Text>
      )}
    </View>
  );
}
