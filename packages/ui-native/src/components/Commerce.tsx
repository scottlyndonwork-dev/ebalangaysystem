import { type Centavos, formatCentavos, type OrderStatus } from '@ebalangay/shared';
import { ORDER_STATUS_TONE } from '@ebalangay/shared/design';
import { Image } from 'expo-image';
import { View } from 'react-native';
import { clampQuantity, cn, starFills } from '../lib/utils.js';
import { IconButton } from './Button.js';
import { Badge, Card } from './Display.js';
import { Text, type TextProps } from './Text.js';

export interface PriceTextProps extends Omit<TextProps, 'children'> {
  centavos: Centavos;
  /** Original price, shown struck through when higher. */
  compareAtCentavos?: Centavos | null;
}

export function PriceText({ centavos, compareAtCentavos, className, ...props }: PriceTextProps) {
  const showCompare = compareAtCentavos != null && compareAtCentavos > centavos;
  return (
    <View className="flex-row items-baseline gap-2">
      <Text className={cn('font-semibold', className)} {...props}>
        {formatCentavos(centavos)}
      </Text>
      {showCompare ? (
        <Text variant="caption" tone="muted" className="line-through">
          {formatCentavos(compareAtCentavos)}
        </Text>
      ) : null}
    </View>
  );
}

export interface RatingStarsProps {
  rating: number;
  /** e.g. t('common:ratingCount', { count }) */
  countLabel?: string;
  /** Screen reader text, e.g. "Rated 4.5 out of 5". */
  accessibilityLabel: string;
  size?: 'sm' | 'md';
}

export function RatingStars({
  rating,
  countLabel,
  accessibilityLabel,
  size = 'sm',
}: RatingStarsProps) {
  const glyph = size === 'sm' ? 'text-sm' : 'text-lg';
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel}
      className="flex-row items-center gap-1"
    >
      <View className="flex-row">
        {starFills(rating).map((fill, i) => (
          <Text
            key={i}
            className={cn(
              glyph,
              fill === 'empty' ? 'text-neutral-300 dark:text-neutral-600' : 'text-amber-500',
              fill === 'half' && 'opacity-60',
            )}
          >
            ★
          </Text>
        ))}
      </View>
      <Text variant="caption" tone="muted">
        {rating.toFixed(1)}
        {countLabel ? ` · ${countLabel}` : ''}
      </Text>
    </View>
  );
}

export interface StatusPillProps {
  status: OrderStatus;
  /** Localised label, e.g. t(`orders:status.${status}`). */
  label: string;
  className?: string;
}

export function StatusPill({ status, label, className }: StatusPillProps) {
  return <Badge label={label} tone={ORDER_STATUS_TONE[status]} className={className} />;
}

export interface QuantityStepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  increaseLabel: string;
  decreaseLabel: string;
  disabled?: boolean;
}

export function QuantityStepper({
  value,
  onChange,
  min = 0,
  max = 99,
  increaseLabel,
  decreaseLabel,
  disabled,
}: QuantityStepperProps) {
  const set = (v: number) => onChange(clampQuantity(v, min, max));
  return (
    <View
      accessibilityRole="adjustable"
      accessibilityValue={{ min, max, now: value }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) =>
        set(value + (e.nativeEvent.actionName === 'increment' ? 1 : -1))
      }
      className="flex-row items-center rounded-full border border-border dark:border-border-dark"
    >
      <IconButton
        accessibilityLabel={decreaseLabel}
        disabled={disabled || value <= min}
        onPress={() => set(value - 1)}
        icon={<Text variant="heading">−</Text>}
      />
      <Text variant="label" className="min-w-8 text-center">
        {value}
      </Text>
      <IconButton
        accessibilityLabel={increaseLabel}
        disabled={disabled || value >= max}
        onPress={() => set(value + 1)}
        icon={<Text variant="heading">+</Text>}
      />
    </View>
  );
}

export interface ProductCardProps {
  name: string;
  imageUrl?: string | null;
  priceCentavos: Centavos;
  compareAtCentavos?: Centavos | null;
  description?: string | null;
  /** Shown as a badge and disables adding, e.g. t('catalog:outOfStock'). */
  unavailableLabel?: string;
  addLabel: string;
  onPress?: () => void;
  onAdd?: () => void;
  layout?: 'row' | 'grid';
}

export function ProductCard({
  name,
  imageUrl,
  priceCentavos,
  compareAtCentavos,
  description,
  unavailableLabel,
  addLabel,
  onPress,
  onAdd,
  layout = 'row',
}: ProductCardProps) {
  const grid = layout === 'grid';
  const img = grid ? { width: '100%' as const, aspectRatio: 1 } : { width: 88, height: 88 };
  return (
    <Card
      onPress={onPress}
      accessibilityLabel={`${name}, ${formatCentavos(priceCentavos)}${unavailableLabel ? `, ${unavailableLabel}` : ''}`}
      padded={false}
      className={cn(grid ? 'flex-1' : 'flex-row', unavailableLabel && 'opacity-60')}
    >
      {imageUrl ? (
        <Image
          source={{ uri: imageUrl }}
          style={img}
          contentFit="cover"
          transition={150}
          accessible={false}
        />
      ) : (
        <View style={img} className="bg-surface-muted dark:bg-surface-muted-dark" />
      )}
      <View className="flex-1 justify-between gap-1 p-3">
        <View className="gap-1">
          <Text variant="label" numberOfLines={2}>
            {name}
          </Text>
          {description && !grid ? (
            <Text variant="caption" tone="muted" numberOfLines={2}>
              {description}
            </Text>
          ) : null}
        </View>
        <View className="flex-row items-center justify-between">
          {unavailableLabel ? (
            <Badge label={unavailableLabel} tone="neutral" />
          ) : (
            <PriceText centavos={priceCentavos} compareAtCentavos={compareAtCentavos} />
          )}
          {onAdd && !unavailableLabel ? (
            <IconButton
              accessibilityLabel={`${addLabel}: ${name}`}
              variant="solid"
              onPress={onAdd}
              icon={
                <Text tone="inverse" variant="heading">
                  +
                </Text>
              }
            />
          ) : null}
        </View>
      </View>
    </Card>
  );
}

export interface StoreCardProps {
  name: string;
  coverUrl?: string | null;
  logoUrl?: string | null;
  rating: number;
  ratingLabel: string;
  /** Pre-formatted meta, e.g. "20-30 mins · ₱49 delivery". */
  meta?: string;
  /** e.g. t('common:time.closed'); dims the card. */
  closedLabel?: string;
  promoLabel?: string;
  onPress: () => void;
}

export function StoreCard({
  name,
  coverUrl,
  logoUrl,
  rating,
  ratingLabel,
  meta,
  closedLabel,
  promoLabel,
  onPress,
}: StoreCardProps) {
  return (
    <Card
      onPress={onPress}
      padded={false}
      accessibilityLabel={[name, ratingLabel, meta, closedLabel].filter(Boolean).join(', ')}
    >
      <View>
        {coverUrl ? (
          <Image
            source={{ uri: coverUrl }}
            style={{ width: '100%', aspectRatio: 2.2 }}
            contentFit="cover"
            transition={150}
            accessible={false}
          />
        ) : (
          <View
            style={{ width: '100%', aspectRatio: 2.2 }}
            className="bg-primary-soft dark:bg-primary-soft-dark"
          />
        )}
        {closedLabel ? (
          <View className="absolute inset-0 items-center justify-center bg-black/50">
            <Text variant="label" className="text-white">
              {closedLabel}
            </Text>
          </View>
        ) : null}
        {promoLabel ? (
          <Badge label={promoLabel} tone="warning" className="absolute left-2 top-2" />
        ) : null}
      </View>
      <View className="flex-row items-center gap-3 p-3">
        {logoUrl ? (
          <Image
            source={{ uri: logoUrl }}
            style={{ width: 40, height: 40, borderRadius: 10 }}
            contentFit="cover"
            accessible={false}
          />
        ) : null}
        <View className="flex-1 gap-0.5">
          <Text variant="label" numberOfLines={1}>
            {name}
          </Text>
          <RatingStars rating={rating} accessibilityLabel={ratingLabel} />
          {meta ? (
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
      </View>
    </Card>
  );
}
