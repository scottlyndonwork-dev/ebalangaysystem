import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AccessibilityInfo, Animated, View, type DimensionValue } from 'react-native';
import type { Tone } from '@ebalangay/shared/design';
import { cn, TONE_CLASSES } from '../lib/utils.js';
import { Button } from './Button.js';
import { Text } from './Text.js';

export interface SkeletonProps {
  width?: DimensionValue;
  height?: DimensionValue;
  rounded?: 'sm' | 'md' | 'lg' | 'full';
  className?: string;
}

/** Pulsing placeholder; hidden from screen readers. */
export function Skeleton({
  width = '100%',
  height = 16,
  rounded = 'md',
  className,
}: SkeletonProps) {
  const opacity = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.5, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  const r = { sm: 'rounded-sm', md: 'rounded-md', lg: 'rounded-lg', full: 'rounded-full' }[rounded];
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width, height, opacity }}
      className={cn('bg-surface-muted dark:bg-surface-muted-dark', r, className)}
    />
  );
}

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

export function EmptyState({
  title,
  description,
  icon,
  actionLabel,
  onAction,
  className,
}: EmptyStateProps) {
  return (
    <View className={cn('items-center justify-center gap-3 px-6 py-10', className)}>
      {icon}
      <Text variant="heading" className="text-center">
        {title}
      </Text>
      {description ? (
        <Text tone="muted" className="text-center">
          {description}
        </Text>
      ) : null}
      {actionLabel && onAction ? (
        <Button label={actionLabel} variant="secondary" onPress={onAction} />
      ) : null}
    </View>
  );
}

export interface ErrorStateProps {
  title: string;
  description?: string;
  retryLabel: string;
  onRetry: () => void;
  retrying?: boolean;
  className?: string;
}

export function ErrorState({
  title,
  description,
  retryLabel,
  onRetry,
  retrying,
  className,
}: ErrorStateProps) {
  return (
    <View
      accessibilityRole="alert"
      className={cn('items-center justify-center gap-3 px-6 py-10', className)}
    >
      <Text variant="heading" tone="danger" className="text-center">
        {title}
      </Text>
      {description ? (
        <Text tone="muted" className="text-center">
          {description}
        </Text>
      ) : null}
      <Button label={retryLabel} variant="outline" onPress={onRetry} loading={retrying} />
    </View>
  );
}

export interface OfflineBannerProps {
  /** Pass your app's connectivity state (e.g. from the socket or a NetInfo hook). */
  offline: boolean;
  message: string;
}

export function OfflineBanner({ offline, message }: OfflineBannerProps) {
  if (!offline) return null;
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      className="min-h-touch flex-row items-center justify-center bg-amber-50 px-4 py-2 dark:bg-amber-700"
    >
      <Text variant="label" className="text-amber-700 dark:text-amber-50">
        {message}
      </Text>
    </View>
  );
}

// Toast

export interface ToastOptions {
  message: string;
  tone?: Extract<Tone, 'neutral' | 'success' | 'danger' | 'warning'>;
  durationMs?: number;
}
interface ToastItem extends Required<ToastOptions> {
  id: number;
}

const ToastContext = createContext<((t: ToastOptions) => void) | null>(null);

/** Mount once near the app root. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const show = useCallback((t: ToastOptions) => {
    const item: ToastItem = { tone: 'neutral', durationMs: 3500, ...t, id: nextId.current++ };
    setToasts((prev) => [...prev.slice(-2), item]);
    AccessibilityInfo.announceForAccessibility(t.message);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== item.id)), item.durationMs);
  }, []);

  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <View pointerEvents="none" className="absolute bottom-16 left-4 right-4 gap-2">
        {toasts.map((t) => (
          <View
            key={t.id}
            accessibilityLiveRegion="polite"
            className={cn(
              'rounded-lg px-4 py-3 shadow-md',
              t.tone === 'neutral' ? 'bg-neutral-800' : TONE_CLASSES[t.tone].container,
            )}
          >
            <Text className={t.tone === 'neutral' ? 'text-white' : TONE_CLASSES[t.tone].text}>
              {t.message}
            </Text>
          </View>
        ))}
      </View>
    </ToastContext.Provider>
  );
}

export function useToast(): (t: ToastOptions) => void {
  const show = useContext(ToastContext);
  if (!show) throw new Error('useToast must be used inside <ToastProvider>');
  return show;
}
