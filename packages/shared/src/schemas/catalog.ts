import { z } from 'zod';
import {
  centavosSchema,
  cursorPageQuerySchema,
  idSchema,
  nonNegativeCentavosSchema,
  timeOfDaySchema,
  timestampSchema,
  urlSchema,
} from './common.js';

// ------------------------------------------------------------------ categories

export const productCategorySchema = z.object({
  id: idSchema,
  merchantId: idSchema,
  name: z.string().min(1).max(80),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  productCount: z.number().int().nonnegative(),
});
export type ProductCategory = z.infer<typeof productCategorySchema>;

export const createCategoryInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  isActive: z.boolean().default(true),
});
export type CreateCategoryInput = z.input<typeof createCategoryInputSchema>;

export const updateCategoryInputSchema = createCategoryInputSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateCategoryInput = z.input<typeof updateCategoryInputSchema>;

/** Full new order: every id listed gets sortOrder = its index. */
export const reorderInputSchema = z.object({
  ids: z
    .array(idSchema)
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate ids'),
});
export type ReorderInput = z.infer<typeof reorderInputSchema>;

// ------------------------------------------------------------------ inventory

export const DietaryTag = {
  VEGETARIAN: 'vegetarian',
  VEGAN: 'vegan',
  HALAL: 'halal',
  GLUTEN_FREE: 'gluten_free',
  DAIRY_FREE: 'dairy_free',
  NUT_FREE: 'nut_free',
  SPICY: 'spicy',
} as const;
export const dietaryTagSchema = z.enum([
  'vegetarian',
  'vegan',
  'halal',
  'gluten_free',
  'dairy_free',
  'nut_free',
  'spicy',
]);
export type DietaryTag = z.infer<typeof dietaryTagSchema>;

/** Stock of one product (no variants) or one variant. Null when inventory isn't tracked. */
export const stockLevelSchema = z.object({
  quantity: z.number().int().nonnegative(),
  lowStockThreshold: z.number().int().nonnegative(),
  isLow: z.boolean(),
  isSoldOut: z.boolean(),
});
export type StockLevel = z.infer<typeof stockLevelSchema>;

export const StockMovementReason = {
  SALE: 'sale',
  RESTOCK: 'restock',
  ADJUSTMENT: 'adjustment',
  WASTE: 'waste',
  RETURN: 'return',
  CANCEL: 'cancel',
} as const;
/** Reasons a merchant may record by hand (sale/cancel come from orders). */
export const manualStockReasonSchema = z.enum(['restock', 'adjustment', 'waste', 'return']);
export const stockMovementReasonSchema = z.enum([
  'sale',
  'restock',
  'adjustment',
  'waste',
  'return',
  'cancel',
]);

export const updateStockInputSchema = z
  .object({
    /** Required when the product has variants (stock is per variant); null otherwise. */
    variantId: idSchema.nullable().default(null),
    /** Absolute quantity for "set", signed delta for "adjust". */
    mode: z.enum(['set', 'adjust']),
    quantity: z.number().int().min(-1_000_000).max(1_000_000),
    reason: manualStockReasonSchema,
    note: z.string().trim().max(200).optional(),
    lowStockThreshold: z.number().int().min(0).max(1_000_000).optional(),
  })
  .refine((v) => v.mode === 'adjust' || v.quantity >= 0, {
    path: ['quantity'],
    message: 'Quantity must be >= 0',
  })
  .refine((v) => v.mode === 'set' || v.quantity !== 0, {
    path: ['quantity'],
    message: 'Adjustment cannot be 0',
  });
export type UpdateStockInput = z.input<typeof updateStockInputSchema>;

export const inventoryItemSchema = z.object({
  productId: idSchema,
  productName: z.string(),
  variantId: idSchema.nullable(),
  variantName: z.string().nullable(),
  sku: z.string().nullable(),
  isKey: z.boolean(),
  stock: stockLevelSchema,
  updatedAt: timestampSchema,
});
export type InventoryItem = z.infer<typeof inventoryItemSchema>;

export const listInventoryQuerySchema = cursorPageQuerySchema.extend({
  /** Only items at or below their low-stock threshold (sold out included). */
  low: z.stringbool().optional(),
});
export type ListInventoryQuery = z.input<typeof listInventoryQuerySchema>;

export const stockMovementSchema = z.object({
  id: idSchema,
  productId: idSchema,
  variantId: idSchema.nullable(),
  delta: z.number().int(),
  reason: stockMovementReasonSchema,
  orderId: idSchema.nullable(),
  actorUserId: idSchema.nullable(),
  note: z.string().nullable(),
  createdAt: timestampSchema,
});
export type StockMovement = z.infer<typeof stockMovementSchema>;

export const listStockMovementsQuerySchema = cursorPageQuerySchema.extend({
  productId: idSchema.optional(),
});
export type ListStockMovementsQuery = z.input<typeof listStockMovementsQuerySchema>;

// ------------------------------------------------------------------ products

export const productImageSchema = z.object({
  id: idSchema,
  /** Full-size WebP (max 2048px). */
  url: urlSchema,
  /** 200px WebP. */
  thumbUrl: urlSchema,
  /** 800px WebP. */
  displayUrl: urlSchema,
  sortOrder: z.number().int(),
});
export type ProductImage = z.infer<typeof productImageSchema>;
export const MAX_PRODUCT_IMAGES = 10;

export const variantSchema = z.object({
  id: idSchema,
  productId: idSchema,
  name: z.string().min(1).max(80),
  priceCentavos: nonNegativeCentavosSchema,
  sku: z.string().max(64).nullable(),
  isAvailable: z.boolean(),
  sortOrder: z.number().int(),
  stock: stockLevelSchema.nullable(),
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
  /** Null = applies to the product (or every variant without its own tiers). */
  variantId: idSchema.nullable(),
  minQuantity: z.number().int().min(2).max(1_000_000),
  unitPriceCentavos: nonNegativeCentavosSchema,
});
export type WholesaleTier = z.infer<typeof wholesaleTierSchema>;

export const productSchema = z.object({
  id: idSchema,
  merchantId: idSchema,
  categoryId: idSchema.nullable(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable(),
  images: z.array(productImageSchema).max(MAX_PRODUCT_IMAGES),
  basePriceCentavos: nonNegativeCentavosSchema,
  compareAtPriceCentavos: nonNegativeCentavosSchema.nullable(),
  sku: z.string().max(64).nullable(),
  isAvailable: z.boolean(),
  /** The store auto-pauses while a key product is sold out. */
  isKey: z.boolean(),
  dietaryTags: z.array(dietaryTagSchema),
  trackInventory: z.boolean(),
  /** Product-level stock; null when untracked or when stock is kept per variant. */
  stock: stockLevelSchema.nullable(),
  /** Tracked and nothing left to sell (all variants sold out, if any). */
  isSoldOut: z.boolean(),
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
      .array(
        z.object({
          id: idSchema.optional(),
          name: z.string().trim().min(1).max(80),
          priceDeltaCentavos: centavosSchema.refine((v) => Math.abs(v) <= 100_000_00, 'Too large'),
          isAvailable: z.boolean().default(true),
        }),
      )
      .min(1)
      .max(50),
  })
  .refine(selectBounds, 'minSelect must be <= maxSelect');

const variantInputSchema = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(80),
  priceCentavos: nonNegativeCentavosSchema,
  sku: z.string().trim().max(64).nullable().default(null),
  isAvailable: z.boolean().default(true),
  /** Opening stock; only on create and only when trackInventory is on. */
  initialStock: z.number().int().nonnegative().max(1_000_000).optional(),
});

/** Tiers reference variants by position in `variants` because new variants have no id yet. */
const wholesaleTierInputSchema = z.object({
  variantIndex: z.number().int().nonnegative().nullable().default(null),
  minQuantity: z.number().int().min(2).max(1_000_000),
  unitPriceCentavos: nonNegativeCentavosSchema,
});

const productFieldsSchema = z.object({
  categoryId: idSchema.nullable().default(null),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullable().default(null),
  basePriceCentavos: nonNegativeCentavosSchema,
  compareAtPriceCentavos: nonNegativeCentavosSchema.nullable().default(null),
  sku: z.string().trim().max(64).nullable().default(null),
  isAvailable: z.boolean().default(true),
  isKey: z.boolean().default(false),
  dietaryTags: z
    .array(dietaryTagSchema)
    .max(7)
    .default([])
    .transform((t) => [...new Set(t)]),
  trackInventory: z.boolean().default(false),
  variants: z.array(variantInputSchema).max(50).default([]),
  modifierGroups: z.array(modifierGroupInputSchema).max(20).default([]),
  wholesaleTiers: z.array(wholesaleTierInputSchema).max(20).default([]),
});

export const createProductInputSchema = productFieldsSchema.extend({
  /** Opening stock for a product without variants; only when trackInventory is on. */
  initialStock: z.number().int().nonnegative().max(1_000_000).optional(),
});
export type CreateProductInput = z.input<typeof createProductInputSchema>;

/**
 * Partial update. `variants`, `modifierGroups` and `wholesaleTiers`, when sent, replace the
 * whole list: items with an `id` are updated, items without are created, missing ones removed.
 * Stock changes go through the inventory endpoint, never here.
 */
export const updateProductInputSchema = productFieldsSchema
  .partial()
  .extend({
    variants: z
      .array(variantInputSchema.omit({ initialStock: true }))
      .max(50)
      .optional(),
    /** Optimistic concurrency: must match the current product version. */
    version: z.number().int().nonnegative(),
  })
  .strict();
export type UpdateProductInput = z.input<typeof updateProductInputSchema>;

export const listProductsQuerySchema = cursorPageQuerySchema.extend({
  categoryId: idSchema.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  available: z.stringbool().optional(),
});
export type ListProductsQuery = z.input<typeof listProductsQuerySchema>;

export const reorderImagesInputSchema = reorderInputSchema;

// ------------------------------------------------------------------ menu schedules

/** Time-boxed menu, e.g. breakfast 06:00-10:30. Empty id lists = the whole menu. */
export const menuScheduleSchema = z.object({
  id: idSchema,
  name: z.string(),
  /** 0 = Sunday … 6 = Saturday, Asia/Manila. */
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: timeOfDaySchema,
  /** May be earlier than startTime: the window runs past midnight. */
  endTime: timeOfDaySchema,
  productIds: z.array(idSchema),
  categoryIds: z.array(idSchema),
  isActive: z.boolean(),
});
export type MenuSchedule = z.infer<typeof menuScheduleSchema>;

export const createMenuScheduleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: timeOfDaySchema,
    endTime: timeOfDaySchema,
    productIds: z.array(idSchema).max(500).default([]),
    categoryIds: z.array(idSchema).max(100).default([]),
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.startTime !== v.endTime, {
    path: ['endTime'],
    message: 'End time must differ from start time',
  });
export type CreateMenuScheduleInput = z.input<typeof createMenuScheduleInputSchema>;

// ------------------------------------------------------------------ CSV import

/**
 * Columns (header row required, case-insensitive): name, price, sku, category, description,
 * compare_at_price, available, is_key, dietary_tags ("vegan|halal"), track_inventory, stock.
 * Rows with a SKU matching an existing product update it; other rows create products.
 */
export const CATALOG_IMPORT_COLUMNS = [
  'name',
  'price',
  'sku',
  'category',
  'description',
  'compare_at_price',
  'available',
  'is_key',
  'dietary_tags',
  'track_inventory',
  'stock',
] as const;
export const MAX_IMPORT_ROWS = 2000;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export const importRowErrorSchema = z.object({
  /** 1-based line number in the file (the header is line 1). */
  line: z.number().int().positive(),
  column: z.string().nullable(),
  message: z.string(),
});
export type ImportRowError = z.infer<typeof importRowErrorSchema>;

export const catalogImportQuerySchema = z.object({
  /** Validate only; report what would happen without writing. */
  dryRun: z.stringbool().default(false),
});

export const catalogImportReportSchema = z.object({
  /** False when there were errors (nothing written) or on a dry run. */
  applied: z.boolean(),
  rowCount: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  categoriesCreated: z.number().int().nonnegative(),
  errors: z.array(importRowErrorSchema),
});
export type CatalogImportReport = z.infer<typeof catalogImportReportSchema>;
