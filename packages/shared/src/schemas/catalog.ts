import { z } from 'zod';
import {
  centavosSchema,
  cursorPageQuerySchema,
  idSchema,
  nonNegativeCentavosSchema,
  timestampSchema,
  urlSchema,
} from './common.js';

export const productCategorySchema = z.object({
  id: idSchema,
  merchantId: idSchema,
  name: z.string().min(1).max(80),
  sortOrder: z.number().int(),
});
export type ProductCategory = z.infer<typeof productCategorySchema>;

export const variantSchema = z.object({
  id: idSchema,
  productId: idSchema,
  name: z.string().min(1).max(80),
  priceCentavos: nonNegativeCentavosSchema,
  sku: z.string().max(64).nullable(),
  isAvailable: z.boolean(),
  stockQuantity: z.number().int().nonnegative().nullable(),
});
export type Variant = z.infer<typeof variantSchema>;

export const modifierOptionSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(80),
  /** May be negative, e.g. "no rice". */
  priceDeltaCentavos: centavosSchema,
  isAvailable: z.boolean(),
});
export type ModifierOption = z.infer<typeof modifierOptionSchema>;

const selectBounds = (g: { minSelect: number; maxSelect: number }) => g.minSelect <= g.maxSelect;

export const modifierGroupSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(80),
    minSelect: z.number().int().min(0).max(20),
    maxSelect: z.number().int().min(1).max(20),
    options: z.array(modifierOptionSchema).min(1).max(50),
  })
  .refine(selectBounds, 'minSelect must be <= maxSelect');
export type ModifierGroup = z.infer<typeof modifierGroupSchema>;

/** Wholesale price breaks; only for supplier/wholesaler merchants. */
export const wholesaleTierSchema = z.object({
  minQuantity: z.number().int().min(2),
  unitPriceCentavos: nonNegativeCentavosSchema,
});
export type WholesaleTier = z.infer<typeof wholesaleTierSchema>;

export const productSchema = z.object({
  id: idSchema,
  merchantId: idSchema,
  categoryId: idSchema.nullable(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable(),
  imageUrls: z.array(urlSchema).max(10),
  basePriceCentavos: nonNegativeCentavosSchema,
  compareAtPriceCentavos: nonNegativeCentavosSchema.nullable(),
  sku: z.string().max(64).nullable(),
  isAvailable: z.boolean(),
  trackInventory: z.boolean(),
  stockQuantity: z.number().int().nonnegative().nullable(),
  variants: z.array(variantSchema),
  modifierGroups: z.array(modifierGroupSchema),
  wholesaleTiers: z.array(wholesaleTierSchema),
  sortOrder: z.number().int(),
  version: z.number().int().nonnegative(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Product = z.infer<typeof productSchema>;

const modifierGroupInputSchema = z
  .object({
    id: idSchema.optional(),
    name: z.string().trim().min(1).max(80),
    minSelect: z.number().int().min(0).max(20),
    maxSelect: z.number().int().min(1).max(20),
    options: z
      .array(modifierOptionSchema.omit({ id: true }).extend({ id: idSchema.optional() }))
      .min(1)
      .max(50),
  })
  .refine(selectBounds, 'minSelect must be <= maxSelect');

export const createProductInputSchema = z.object({
  categoryId: idSchema.nullable().default(null),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullable().default(null),
  imageFileKeys: z.array(z.string().max(512)).max(10).default([]),
  basePriceCentavos: nonNegativeCentavosSchema,
  compareAtPriceCentavos: nonNegativeCentavosSchema.nullable().default(null),
  sku: z.string().trim().max(64).nullable().default(null),
  isAvailable: z.boolean().default(true),
  trackInventory: z.boolean().default(false),
  stockQuantity: z.number().int().nonnegative().nullable().default(null),
  variants: z
    .array(variantSchema.omit({ id: true, productId: true }).extend({ id: idSchema.optional() }))
    .max(50)
    .default([]),
  modifierGroups: z.array(modifierGroupInputSchema).max(20).default([]),
  wholesaleTiers: z.array(wholesaleTierSchema).max(10).default([]),
});
export type CreateProductInput = z.input<typeof createProductInputSchema>;

export const updateProductInputSchema = createProductInputSchema.partial().extend({
  /** Optimistic concurrency: must match the current product version. */
  version: z.number().int().nonnegative(),
});
export type UpdateProductInput = z.input<typeof updateProductInputSchema>;

export const listProductsQuerySchema = cursorPageQuerySchema.extend({
  categoryId: idSchema.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  available: z.stringbool().optional(),
});
export type ListProductsQuery = z.input<typeof listProductsQuerySchema>;

export const updateStockInputSchema = z.object({
  variantId: idSchema.nullable(),
  /** Absolute quantity, or a signed delta when `mode` is "adjust". */
  quantity: z.number().int(),
  mode: z.enum(['set', 'adjust']),
  reason: z.string().trim().max(200).optional(),
});
export type UpdateStockInput = z.infer<typeof updateStockInputSchema>;
