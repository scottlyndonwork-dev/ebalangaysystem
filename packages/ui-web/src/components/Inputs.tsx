'use client';
import {
  type Centavos,
  centavosToPesos,
  DISPLAY_TIME_ZONE,
  type OrderStatus,
  type PresignUploadResponse,
  pesosToCentavos,
} from '@ebalangay/shared';
import { ORDER_STATUS_TONE } from '@ebalangay/shared/design';
import { CalendarDays, UploadCloud } from 'lucide-react';
import { type ComponentProps, type DragEvent, useId, useRef, useState } from 'react';
import { type DateRange, DayPicker } from 'react-day-picker';
import { cn, formatBytes, TONE_CLASSES } from '../lib/utils.js';
import { Button, Input, Popover, PopoverContent, PopoverTrigger } from './primitives.js';

export interface StatusPillProps {
  status: OrderStatus;
  /** Localised label, e.g. t(`orders:status.${status}`). */
  label: string;
  className?: string;
}

export function StatusPill({ status, label, className }: StatusPillProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold',
        TONE_CLASSES[ORDER_STATUS_TONE[status]],
        className,
      )}
    >
      {label}
    </span>
  );
}

/** Parse what a user typed into centavos; null when empty or invalid. */
export function parseMoneyInput(text: string): Centavos | null {
  const t = text.trim();
  if (!t) return null;
  try {
    return pesosToCentavos(t);
  } catch {
    return null;
  }
}

export interface MoneyInputProps extends Omit<
  ComponentProps<'input'>,
  'value' | 'onChange' | 'type'
> {
  value: Centavos | null;
  onChange: (value: Centavos | null) => void;
  allowNegative?: boolean;
}

/** Peso text field that only ever emits integer centavos. */
export function MoneyInput({
  value,
  onChange,
  allowNegative = false,
  className,
  onBlur,
  ...props
}: MoneyInputProps) {
  const [text, setText] = useState(value === null ? '' : centavosToPesos(value));
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    // Parent changed the value: resync the text (derived state during render).
    setLastValue(value);
    if (value !== parseMoneyInput(text)) setText(value === null ? '' : centavosToPesos(value));
  }
  return (
    <div className={cn('relative', className)}>
      <span
        aria-hidden
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
      >
        ₱
      </span>
      <Input
        {...props}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={text}
        className="pl-7 tabular-nums"
        onChange={(e) => {
          const next = e.target.value.replace(allowNegative ? /[^\d.,-]/g : /[^\d.,]/g, '');
          setText(next);
          const parsed = parseMoneyInput(next);
          setLastValue(parsed);
          onChange(parsed);
        }}
        onBlur={(e) => {
          const parsed = parseMoneyInput(text);
          setText(parsed === null ? '' : centavosToPesos(parsed));
          onBlur?.(e);
        }}
      />
    </div>
  );
}

export interface DateRangePreset {
  label: string;
  range: () => DateRange;
}

export interface DateRangePickerProps {
  value: DateRange | undefined;
  onChange: (range: DateRange | undefined) => void;
  presets?: readonly DateRangePreset[];
  placeholder: string;
  /** Formats the trigger text; defaults to Asia/Manila medium dates. */
  formatDate?: (d: Date) => string;
  className?: string;
}

const manilaDate = (d: Date) =>
  new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeZone: DISPLAY_TIME_ZONE }).format(d);

export function DateRangePicker({
  value,
  onChange,
  presets = [],
  placeholder,
  formatDate = manilaDate,
  className,
}: DateRangePickerProps) {
  const text = value?.from
    ? value.to
      ? `${formatDate(value.from)} – ${formatDate(value.to)}`
      : formatDate(value.from)
    : placeholder;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            'justify-start font-normal',
            !value?.from && 'text-muted-foreground',
            className,
          )}
        >
          <CalendarDays /> {text}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="flex w-auto flex-col gap-3 sm:flex-row">
        {presets.length ? (
          <div className="flex flex-row flex-wrap gap-1 sm:flex-col">
            {presets.map((p) => (
              <Button
                key={p.label}
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => onChange(p.range())}
              >
                {p.label}
              </Button>
            ))}
          </div>
        ) : null}
        <DayPicker
          mode="range"
          selected={value}
          onSelect={onChange}
          numberOfMonths={2}
          defaultMonth={value?.from}
        />
      </PopoverContent>
    </Popover>
  );
}

export interface FileUploadLabels {
  prompt: string;
  browse: string;
  uploading: string;
  tooLarge: (maxSize: string) => string;
  wrongType: string;
  failed: string;
}

export interface FileUploadProps {
  /** Ask the API for a presigned R2 URL (POST /v1/uploads/presign). */
  presign: (file: File) => Promise<PresignUploadResponse>;
  onUploaded: (result: { fileKey: string; publicUrl: string | null; file: File }) => void;
  accept?: string;
  maxSizeBytes?: number;
  labels: FileUploadLabels;
  disabled?: boolean;
  className?: string;
}

/** PUT with progress; fetch has no upload progress events, so this uses XHR. */
export function uploadToPresignedUrl(
  file: File,
  presigned: PresignUploadResponse,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(presigned.method, presigned.uploadUrl);
    for (const [k, v] of Object.entries(presigned.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) =>
      e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed: ${xhr.status}`));
    xhr.onerror = () => reject(new Error('Upload network error'));
    xhr.send(file);
  });
}

export function matchesAccept(file: { name: string; type: string }, accept?: string): boolean {
  if (!accept) return true;
  return accept.split(',').some((raw) => {
    const a = raw.trim().toLowerCase();
    if (a.startsWith('.')) return file.name.toLowerCase().endsWith(a);
    if (a.endsWith('/*')) return file.type.toLowerCase().startsWith(a.slice(0, -1));
    return file.type.toLowerCase() === a;
  });
}

export function FileUpload({
  presign,
  onUploaded,
  accept,
  maxSizeBytes = 10 * 1024 * 1024,
  labels,
  disabled,
  className,
}: FileUploadProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const busy = progress !== null;

  async function handle(file: File | undefined) {
    if (!file || busy) return;
    setError(null);
    if (!matchesAccept(file, accept)) return setError(labels.wrongType);
    if (file.size > maxSizeBytes) return setError(labels.tooLarge(formatBytes(maxSizeBytes)));
    setProgress(0);
    try {
      const presigned = await presign(file);
      await uploadToPresignedUrl(file, presigned, setProgress);
      onUploaded({ fileKey: presigned.fileKey, publicUrl: presigned.publicUrl, file });
    } catch {
      setError(labels.failed);
    } finally {
      setProgress(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!disabled) void handle(e.dataTransfer.files[0]);
  };

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center text-sm transition-colors',
          dragging ? 'border-primary bg-primary-soft' : 'hover:bg-surface',
          (disabled || busy) && 'cursor-not-allowed opacity-60',
        )}
      >
        <UploadCloud aria-hidden className="size-6 text-muted-foreground" />
        {busy ? (
          <span aria-live="polite">
            {labels.uploading} {progress}%
          </span>
        ) : (
          <span>
            {labels.prompt} <span className="font-medium text-primary">{labels.browse}</span>
          </span>
        )}
        {busy ? (
          <progress
            max={100}
            value={progress ?? 0}
            className="h-1.5 w-full max-w-60 accent-[var(--primary)]"
            aria-label={labels.uploading}
          />
        ) : null}
      </label>
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept={accept}
        disabled={disabled || busy}
        className="sr-only"
        onChange={(e) => void handle(e.target.files?.[0])}
      />
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
