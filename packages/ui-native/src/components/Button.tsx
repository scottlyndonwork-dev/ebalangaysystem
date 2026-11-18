import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, type PressableProps, View } from 'react-native';
import { cn } from '../lib/utils.js';
import { HIT_SLOP, useThemeColors } from '../theme.js';
import { Text } from './Text.js';

const variants = {
  primary: {
    box: 'bg-primary dark:bg-primary-dark',
    text: 'text-primary-foreground dark:text-primary-foreground-dark',
  },
  secondary: {
    box: 'bg-primary-soft dark:bg-primary-soft-dark',
    text: 'text-brand-800 dark:text-brand-50',
  },
  outline: {
    box: 'border border-border dark:border-border-dark bg-transparent',
    text: 'text-text dark:text-text-dark',
  },
  ghost: { box: 'bg-transparent', text: 'text-primary dark:text-primary-dark' },
  danger: { box: 'bg-danger dark:bg-danger-dark', text: 'text-white' },
} as const;

const sizes = {
  sm: { box: 'min-h-touch px-3 rounded-md', text: 'text-sm' },
  md: { box: 'min-h-12 px-4 rounded-lg', text: 'text-base' },
  lg: { box: 'min-h-14 px-6 rounded-lg', text: 'text-lg' },
} as const;

export interface ButtonProps extends Omit<PressableProps, 'children'> {
  label: string;
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  loading?: boolean;
  fullWidth?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  className?: string;
}

export function Button({
  label,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  fullWidth,
  leftIcon,
  rightIcon,
  className,
  ...props
}: ButtonProps) {
  const colors = useThemeColors();
  const inactive = Boolean(disabled) || loading;
  const v = variants[variant];
  const s = sizes[size];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      hitSlop={HIT_SLOP}
      className={cn(
        'flex-row items-center justify-center gap-2 active:opacity-80',
        v.box,
        s.box,
        fullWidth && 'w-full',
        inactive && 'opacity-50',
        className,
      )}
      {...props}
    >
      {loading ? (
        <ActivityIndicator
          color={
            variant === 'primary' || variant === 'danger'
              ? colors.primaryForeground
              : colors.primary
          }
        />
      ) : (
        <>
          {leftIcon ? <View>{leftIcon}</View> : null}
          <Text className={cn('font-semibold', v.text, s.text)} numberOfLines={1}>
            {label}
          </Text>
          {rightIcon ? <View>{rightIcon}</View> : null}
        </>
      )}
    </Pressable>
  );
}

export interface IconButtonProps extends Omit<PressableProps, 'children'> {
  icon: ReactNode;
  /** Required: icon-only controls must be named for screen readers. */
  accessibilityLabel: string;
  variant?: 'solid' | 'soft' | 'ghost';
  className?: string;
}

const iconVariants = {
  solid: 'bg-primary dark:bg-primary-dark',
  soft: 'bg-primary-soft dark:bg-primary-soft-dark',
  ghost: 'bg-transparent',
} as const;

export function IconButton({
  icon,
  variant = 'ghost',
  disabled,
  className,
  ...props
}: IconButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={HIT_SLOP}
      className={cn(
        'min-h-touch min-w-touch items-center justify-center rounded-full active:opacity-70',
        iconVariants[variant],
        disabled && 'opacity-50',
        className,
      )}
      {...props}
    >
      {icon}
    </Pressable>
  );
}
