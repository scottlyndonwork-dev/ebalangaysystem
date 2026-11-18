import { type ReactNode, useEffect, useRef } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Modal as RNModal,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import { cn } from '../lib/utils.js';
import { Text } from './Text.js';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Label for the backdrop "close" target, e.g. t('common:actions.close'). */
  closeLabel: string;
  children: ReactNode;
  /** Max height as a fraction of the screen. */
  maxHeight?: `${number}%`;
}

/** Bottom sheet built on RN Modal: backdrop tap, Android back and swipe-free close. */
export function Sheet({
  open,
  onClose,
  title,
  closeLabel,
  children,
  maxHeight = '85%',
}: SheetProps) {
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fade, { toValue: open ? 1 : 0, duration: 180, useNativeDriver: true }).start();
  }, [open, fade]);

  return (
    <RNModal
      visible={open}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Animated.View style={{ opacity: fade }} className="absolute inset-0 bg-black/40">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
          onPress={onClose}
          className="flex-1"
        />
      </Animated.View>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="absolute bottom-0 left-0 right-0"
      >
        <View
          accessibilityViewIsModal
          style={{ maxHeight }}
          className="rounded-t-xl bg-background pb-8 dark:bg-background-dark"
        >
          <View className="items-center py-2" accessible={false}>
            <View className="h-1 w-10 rounded-full bg-border dark:bg-border-dark" />
          </View>
          {title ? (
            <Text variant="heading" className="px-4 pb-2">
              {title}
            </Text>
          ) : null}
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="px-4 pb-2">
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </RNModal>
  );
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  /** Usually Buttons. */
  actions?: ReactNode;
  /** Prevent closing by backdrop tap (e.g. destructive confirmations in progress). */
  dismissable?: boolean;
  className?: string;
}

/** Centered dialog. */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  actions,
  dismissable = true,
  className,
}: ModalProps) {
  return (
    <RNModal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={dismissable ? onClose : () => {}}
    >
      <Pressable
        accessible={false}
        onPress={dismissable ? onClose : undefined}
        className="flex-1 items-center justify-center bg-black/40 px-6"
      >
        <Pressable
          accessible={false}
          accessibilityViewIsModal
          onPress={() => {}}
          className={cn(
            'w-full max-w-md gap-3 rounded-xl bg-background p-5 dark:bg-background-dark',
            className,
          )}
        >
          <Text variant="heading">{title}</Text>
          {description ? <Text tone="muted">{description}</Text> : null}
          {children}
          {actions ? <View className="mt-2 flex-row justify-end gap-2">{actions}</View> : null}
        </Pressable>
      </Pressable>
    </RNModal>
  );
}
