import { type ReactNode, type Ref, useRef, useState } from 'react';
import { Pressable, TextInput, type TextInputProps, View } from 'react-native';
import { cn, sanitizeOtp } from '../lib/utils.js';
import { useThemeColors } from '../theme.js';
import { Text } from './Text.js';

export interface InputProps extends TextInputProps {
  label: string;
  /** Shown below the field and announced to screen readers. */
  error?: string;
  hint?: string;
  left?: ReactNode;
  right?: ReactNode;
  className?: string;
  ref?: Ref<TextInput>;
}

export function Input({
  label,
  error,
  hint,
  left,
  right,
  className,
  editable = true,
  ...props
}: InputProps) {
  const colors = useThemeColors();
  const [focused, setFocused] = useState(false);
  return (
    <View className={cn('gap-1', className)}>
      <Text variant="label">{label}</Text>
      <View
        className={cn(
          'min-h-12 flex-row items-center gap-2 rounded-lg border bg-background px-3 dark:bg-background-dark',
          error
            ? 'border-danger dark:border-danger-dark'
            : focused
              ? 'border-primary dark:border-primary-dark'
              : 'border-border dark:border-border-dark',
          !editable && 'opacity-60',
        )}
      >
        {left}
        <TextInput
          accessibilityLabel={label}
          accessibilityHint={error ?? hint}
          accessibilityState={{ disabled: !editable }}
          aria-invalid={Boolean(error)}
          placeholderTextColor={colors.textMuted}
          maxFontSizeMultiplier={2}
          className="min-h-touch flex-1 text-base text-text dark:text-text-dark"
          {...props}
          editable={editable}
          onFocus={(e) => {
            setFocused(true);
            props.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            props.onBlur?.(e);
          }}
        />
        {right}
      </View>
      {error ? (
        <Text variant="caption" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export interface OTPInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Fires once all digits are entered. */
  onComplete?: (value: string) => void;
  length?: number;
  accessibilityLabel: string;
  error?: string;
  autoFocus?: boolean;
}

/** One hidden TextInput behind digit boxes, so SMS autofill and paste both work. */
export function OTPInput({
  value,
  onChange,
  onComplete,
  length = 6,
  accessibilityLabel,
  error,
  autoFocus,
}: OTPInputProps) {
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const digits = sanitizeOtp(value, length);
  return (
    <View className="gap-2">
      <Pressable
        onPress={() => inputRef.current?.focus()}
        accessible={false}
        className="flex-row justify-between gap-2"
      >
        {Array.from({ length }, (_, i) => {
          const active =
            focused && (i === digits.length || (i === length - 1 && digits.length === length));
          return (
            <View
              key={i}
              className={cn(
                'h-14 flex-1 items-center justify-center rounded-lg border-2 bg-background dark:bg-background-dark',
                error
                  ? 'border-danger dark:border-danger-dark'
                  : active
                    ? 'border-primary dark:border-primary-dark'
                    : 'border-border dark:border-border-dark',
              )}
            >
              <Text variant="title">{digits[i] ?? ''}</Text>
            </View>
          );
        })}
      </Pressable>
      <TextInput
        ref={inputRef}
        value={digits}
        onChangeText={(text) => {
          const next = sanitizeOtp(text, length);
          onChange(next);
          if (next.length === length) onComplete?.(next);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        maxLength={length}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="sms-otp"
        autoFocus={autoFocus}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={error}
        caretHidden
        className="absolute h-px w-px opacity-0"
      />
      {error ? (
        <Text variant="caption" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
