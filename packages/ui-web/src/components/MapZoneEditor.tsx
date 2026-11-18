'use client';
import type { LatLng } from '@ebalangay/shared';
import { cn } from '../lib/utils.js';

export interface MapZoneEditorProps {
  /** Closed ring (first point repeated last), as in zoneSchema.polygon. */
  value: readonly LatLng[];
  onChange?: (polygon: LatLng[]) => void;
  /** e.g. "Map editor coming soon. Zone has {n} points." */
  placeholder: string;
  ariaLabel: string;
  className?: string;
}

/** Project a ring into a 100x100 SVG viewBox (north up). */
export function ringToSvgPoints(ring: readonly LatLng[]): string {
  if (ring.length === 0) return '';
  const lats = ring.map((p) => p.lat);
  const lngs = ring.map((p) => p.lng);
  const [minLat, maxLat, minLng, maxLng] = [
    Math.min(...lats),
    Math.max(...lats),
    Math.min(...lngs),
    Math.max(...lngs),
  ];
  const span = Math.max(maxLat - minLat, maxLng - minLng) || 1;
  return ring
    .map(
      (p) =>
        `${(((p.lng - minLng) / span) * 90 + 5).toFixed(2)},${(((maxLat - p.lat) / span) * 90 + 5).toFixed(2)}`,
    )
    .join(' ');
}

/**
 * Placeholder: read-only outline preview. The Google Maps drawing editor lands with the
 * admin zones phase; `onChange` is part of the API now so callers don't change later.
 */
export function MapZoneEditor({ value, placeholder, ariaLabel, className }: MapZoneEditorProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-2 rounded-lg border border-dashed bg-surface p-4',
        className,
      )}
    >
      <svg viewBox="0 0 100 100" className="size-48" role="img" aria-label={ariaLabel}>
        {value.length > 2 ? (
          <polygon
            points={ringToSvgPoints(value)}
            fill="var(--primary-soft)"
            stroke="var(--primary)"
            strokeWidth={1.5}
          />
        ) : null}
      </svg>
      <p className="text-center text-sm text-muted-foreground">{placeholder}</p>
    </div>
  );
}
