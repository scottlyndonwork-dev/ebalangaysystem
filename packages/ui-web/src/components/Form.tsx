'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { AlertDialog, Slot } from 'radix-ui';
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useId,
  useState,
} from 'react';
import {
  Controller,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
  FormProvider,
  type Resolver,
  useForm,
  type UseFormProps,
  useFormContext,
  useFormState,
} from 'react-hook-form';
import type { z } from 'zod';
import { cn } from '../lib/utils.js';
import { Button, buttonVariants, Label } from './primitives.js';

/** react-hook-form bound to a shared Zod schema (the same one the API validates with). */
export function useZodForm<S extends z.ZodType<FieldValues, FieldValues>>(
  schema: S,
  options: Omit<UseFormProps<z.input<S>, unknown, z.output<S>>, 'resolver'> = {},
) {
  return useForm<z.input<S>, unknown, z.output<S>>({
    mode: 'onTouched',
    ...options,
    // zodResolver infers FieldValues from the generic bound; the schema fixes the real types.
    resolver: zodResolver(schema) as unknown as Resolver<z.input<S>, unknown, z.output<S>>,
  });
}

export const Form = FormProvider;

const FieldContext = createContext<{ name: string } | null>(null);
const ItemContext = createContext<{ id: string } | null>(null);

export function FormField<TValues extends FieldValues, TName extends FieldPath<TValues>>(
  props: ControllerProps<TValues, TName>,
) {
  return (
    <FieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FieldContext.Provider>
  );
}

export function useFormField() {
  const field = useContext(FieldContext);
  const item = useContext(ItemContext);
  const { getFieldState } = useFormContext();
  const formState = useFormState({ name: field?.name });
  if (!field || !item)
    throw new Error('useFormField must be used inside <FormField> and <FormItem>');
  const state = getFieldState(field.name, formState);
  return {
    name: field.name,
    controlId: `${item.id}-control`,
    descriptionId: `${item.id}-description`,
    messageId: `${item.id}-message`,
    error: state.error,
  };
}

export function FormItem({ className, ...props }: ComponentProps<'div'>) {
  const id = useId();
  return (
    <ItemContext.Provider value={{ id }}>
      <div className={cn('flex flex-col gap-1.5', className)} {...props} />
    </ItemContext.Provider>
  );
}

export function FormLabel({ className, ...props }: ComponentProps<'label'>) {
  const { controlId, error } = useFormField();
  return <Label htmlFor={controlId} className={cn(error && 'text-danger', className)} {...props} />;
}

/** Wraps the input; wires id, aria-invalid and aria-describedby. */
export function FormControl(props: ComponentProps<typeof Slot.Root>) {
  const { controlId, descriptionId, messageId, error } = useFormField();
  return (
    <Slot.Root
      id={controlId}
      aria-invalid={Boolean(error)}
      aria-describedby={error ? `${descriptionId} ${messageId}` : descriptionId}
      {...props}
    />
  );
}

export function FormDescription({ className, ...props }: ComponentProps<'p'>) {
  const { descriptionId } = useFormField();
  return (
    <p id={descriptionId} className={cn('text-xs text-muted-foreground', className)} {...props} />
  );
}

/**
 * Shows the field's error. Pass `translate` to map Zod messages/codes to i18n strings.
 */
export function FormMessage({
  className,
  translate,
  children,
  ...props
}: ComponentProps<'p'> & { translate?: (message: string) => string }) {
  const { messageId, error } = useFormField();
  const raw = error?.message ? String(error.message) : null;
  const body = raw ? (translate ? translate(raw) : raw) : children;
  if (!body) return null;
  return (
    <p
      id={messageId}
      role="alert"
      className={cn('text-xs font-medium text-danger', className)}
      {...props}
    >
      {body}
    </p>
  );
}

export interface ConfirmDialogProps {
  /** The element that opens the dialog (e.g. a Button). */
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  /** May be async; the dialog stays open with a busy button until it resolves. */
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  trigger,
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive,
  onConfirm,
}: ConfirmDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const isOpen = open ?? internalOpen;
  const setOpen = (v: boolean) => {
    if (busy) return;
    setInternalOpen(v);
    onOpenChange?.(v);
  };

  return (
    <AlertDialog.Root open={isOpen} onOpenChange={setOpen}>
      {trigger ? <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger> : null}
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border bg-background p-6 shadow-lg data-[state=open]:animate-in data-[state=open]:zoom-in-95">
          <AlertDialog.Title className="text-lg font-semibold">{title}</AlertDialog.Title>
          {description ? (
            <AlertDialog.Description className="text-sm text-muted-foreground">
              {description}
            </AlertDialog.Description>
          ) : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialog.Cancel className={buttonVariants({ variant: 'outline' })} disabled={busy}>
              {cancelLabel}
            </AlertDialog.Cancel>
            <Button
              variant={destructive ? 'destructive' : 'default'}
              aria-busy={busy}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  setBusy(false);
                  setInternalOpen(false);
                  onOpenChange?.(false);
                } catch {
                  setBusy(false);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
