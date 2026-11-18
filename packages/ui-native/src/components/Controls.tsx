import { useState } from 'react';
import { Pressable, Switch as RNSwitch, View } from 'react-native';
import { cn } from '../lib/utils.js';
import { HIT_SLOP, useThemeColors } from '../theme.js';
import { Sheet } from './Overlay.js';
import { Text } from './Text.js';

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled,
  className,
}: CheckboxProps) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ checked, disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      hitSlop={HIT_SLOP}
      className={cn('min-h-touch flex-row items-center gap-3', disabled && 'opacity-50', className)}
    >
      <View
        className={cn(
          'h-6 w-6 items-center justify-center rounded-sm border-2',
          checked
            ? 'border-primary bg-primary dark:border-primary-dark dark:bg-primary-dark'
            : 'border-border dark:border-border-dark',
        )}
      >
        {checked ? (
          <Text tone="inverse" className="text-sm font-bold" accessible={false}>
            ✓
          </Text>
        ) : null}
      </View>
      <View className="flex-1">
        <Text>{label}</Text>
        {description ? (
          <Text variant="caption" tone="muted">
            {description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export interface SwitchProps {
  value: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  className?: string;
}

export function Switch({ value, onChange, label, description, disabled, className }: SwitchProps) {
  const colors = useThemeColors();
  return (
    <View className={cn('min-h-touch flex-row items-center gap-3', className)}>
      <View className="flex-1">
        <Text>{label}</Text>
        {description ? (
          <Text variant="caption" tone="muted">
            {description}
          </Text>
        ) : null}
      </View>
      <RNSwitch
        accessibilityLabel={label}
        accessibilityHint={description}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: colors.border, true: colors.primary }}
        thumbColor={colors.background}
        ios_backgroundColor={colors.border}
      />
    </View>
  );
}

export interface SelectOption<T extends string> {
  label: string;
  value: T;
  description?: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string> {
  label: string;
  value: T | null;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  placeholder: string;
  closeLabel: string;
  error?: string;
  disabled?: boolean;
  className?: string;
}

/** Field that opens a bottom sheet of options. */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  placeholder,
  closeLabel,
  error,
  disabled,
  className,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  return (
    <View className={cn('gap-1', className)}>
      <Text variant="label">{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${selected?.label ?? placeholder}`}
        accessibilityHint={error}
        accessibilityState={{ disabled: Boolean(disabled), expanded: open }}
        disabled={disabled}
        onPress={() => setOpen(true)}
        className={cn(
          'min-h-12 flex-row items-center justify-between rounded-lg border bg-background px-3 dark:bg-background-dark',
          error ? 'border-danger dark:border-danger-dark' : 'border-border dark:border-border-dark',
          disabled && 'opacity-60',
        )}
      >
        <Text tone={selected ? 'default' : 'muted'} numberOfLines={1} className="flex-1">
          {selected?.label ?? placeholder}
        </Text>
        <Text tone="muted" accessible={false}>
          ▾
        </Text>
      </Pressable>
      {error ? (
        <Text variant="caption" tone="danger">
          {error}
        </Text>
      ) : null}
      <Sheet open={open} onClose={() => setOpen(false)} title={label} closeLabel={closeLabel}>
        {options.map((o) => {
          const isSelected = o.value === value;
          return (
            <Pressable
              key={o.value}
              accessibilityRole="radio"
              accessibilityLabel={o.label}
              accessibilityState={{ selected: isSelected, disabled: Boolean(o.disabled) }}
              disabled={o.disabled}
              onPress={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={cn(
                'min-h-12 flex-row items-center justify-between rounded-md px-2',
                isSelected && 'bg-primary-soft dark:bg-primary-soft-dark',
                o.disabled && 'opacity-50',
              )}
            >
              <View className="flex-1">
                <Text>{o.label}</Text>
                {o.description ? (
                  <Text variant="caption" tone="muted">
                    {o.description}
                  </Text>
                ) : null}
              </View>
              {isSelected ? (
                <Text tone="primary" accessible={false}>
                  ✓
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </Sheet>
    </View>
  );
}
