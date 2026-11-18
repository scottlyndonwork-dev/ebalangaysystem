import type { LatLng } from '@ebalangay/shared';
import { Image } from 'expo-image';
import * as ExpoImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, View } from 'react-native';
import RNMapView, {
  Marker,
  type MapViewProps as RNMapViewProps,
  PROVIDER_GOOGLE,
} from 'react-native-maps';
import { cn } from '../lib/utils.js';
import { useThemeColors } from '../theme.js';
import { Text } from './Text.js';

/** Butuan City: launch market. */
export const DEFAULT_MAP_CENTER: LatLng = { lat: 8.9475, lng: 125.5406 };

export interface MapMarker {
  id: string;
  coordinate: LatLng;
  title?: string;
  /** 'brand' = store/rider, 'accent' = customer drop-off. */
  tone?: 'brand' | 'accent';
}

export interface MapViewProps extends Omit<RNMapViewProps, 'initialRegion'> {
  center?: LatLng;
  /** Degrees of latitude visible. */
  zoomDelta?: number;
  markers?: readonly MapMarker[];
  /** Screen readers can't use maps; describe what it shows. */
  accessibilityLabel: string;
  className?: string;
}

/** Google Maps on both platforms (consistent with server-side Google routing). */
export function MapView({
  center = DEFAULT_MAP_CENTER,
  zoomDelta = 0.02,
  markers = [],
  accessibilityLabel,
  className,
  style,
  ...props
}: MapViewProps) {
  const colors = useThemeColors();
  return (
    <View
      className={cn('overflow-hidden rounded-lg', className)}
      accessible
      accessibilityLabel={accessibilityLabel}
    >
      <RNMapView
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
        style={[{ width: '100%', height: '100%' }, style]}
        initialRegion={{
          latitude: center.lat,
          longitude: center.lng,
          latitudeDelta: zoomDelta,
          longitudeDelta: zoomDelta,
        }}
        importantForAccessibility="no-hide-descendants"
        {...props}
      >
        {markers.map((m) => (
          <Marker
            key={m.id}
            coordinate={{ latitude: m.coordinate.lat, longitude: m.coordinate.lng }}
            title={m.title}
            pinColor={m.tone === 'accent' ? colors.accent : colors.primary}
          />
        ))}
      </RNMapView>
    </View>
  );
}

export interface PickedImage {
  uri: string;
  width: number;
  height: number;
  mimeType: string | null;
  fileSize: number | null;
  fileName: string | null;
}

export interface ImagePickerProps {
  value: string | null;
  onPick: (image: PickedImage) => void;
  label: string;
  /** Shown when permission is denied. */
  permissionDeniedLabel: string;
  aspect?: [number, number];
  disabled?: boolean;
  className?: string;
}

export function ImagePicker({
  value,
  onPick,
  label,
  permissionDeniedLabel,
  aspect = [1, 1],
  disabled,
  className,
}: ImagePickerProps) {
  const colors = useThemeColors();
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);

  async function pick() {
    setBusy(true);
    try {
      const perm = await ExpoImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setDenied(true);
        return;
      }
      setDenied(false);
      const result = await ExpoImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect,
        quality: 0.8,
      });
      const asset = result.canceled ? undefined : result.assets[0];
      if (asset) {
        onPick({
          uri: asset.uri,
          width: asset.width,
          height: asset.height,
          mimeType: asset.mimeType ?? null,
          fileSize: asset.fileSize ?? null,
          fileName: asset.fileName ?? null,
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className={cn('gap-1', className)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: Boolean(disabled), busy }}
        disabled={disabled || busy}
        onPress={() => void pick()}
        style={{ aspectRatio: aspect[0] / aspect[1] }}
        className="min-h-touch w-full items-center justify-center overflow-hidden rounded-lg border-2 border-dashed border-border bg-surface active:opacity-80 dark:border-border-dark dark:bg-surface-dark"
      >
        {value ? (
          <Image
            source={{ uri: value }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            accessible={false}
          />
        ) : busy ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          <Text tone="muted">{label}</Text>
        )}
      </Pressable>
      {denied ? (
        <Text variant="caption" tone="danger" accessibilityLiveRegion="polite">
          {permissionDeniedLabel}
        </Text>
      ) : null}
    </View>
  );
}
