import { Text as RNText, type TextProps as RNTextProps } from 'react-native';
import { cn } from '../lib/utils.js';

const variants = {
  display: 'text-3xl font-bold',
  title: 'text-2xl font-bold',
  heading: 'text-lg font-semibold',
  body: 'text-base',
  label: 'text-sm font-medium',
  caption: 'text-xs',
} as const;

const tones = {
  default: 'text-text dark:text-text-dark',
  muted: 'text-text-muted dark:text-text-muted-dark',
  primary: 'text-primary dark:text-primary-dark',
  danger: 'text-danger dark:text-danger-dark',
  inverse: 'text-primary-foreground dark:text-primary-foreground-dark',
} as const;

export interface TextProps extends RNTextProps {
  variant?: keyof typeof variants;
  tone?: keyof typeof tones;
  className?: string;
}

/** Respects the user's font scaling up to 2x so layouts don't explode. */
export function Text({ variant = 'body', tone = 'default', className, ...props }: TextProps) {
  const isHeading = variant === 'display' || variant === 'title' || variant === 'heading';
  return (
    <RNText
      accessibilityRole={isHeading ? 'header' : undefined}
      maxFontSizeMultiplier={2}
      className={cn(variants[variant], tones[tone], className)}
      {...props}
    />
  );
}
