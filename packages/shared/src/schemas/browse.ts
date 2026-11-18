import { z } from 'zod';
import { businessTypeSchema } from '../enums.js';
import {
  dietaryTagSchema,
  modifierGroupSchema,
  productImageSchema,
  wholesaleTierSchema,
} from './catalog.js';
import {
  cursorPageQuerySchema,
  cursorPageSchema,
  idSchema,
  latLngSchema,
  nonNegativeCentavosSchema,
  urlSchema,
} from './common.js';
import { holidayClosureSchema, merchantSummarySchema, storeHoursSlotSchema } from './merchant.js';

/** "Budget" filter: the store sells something at or under ₱100. */
export const BUDGET_PRICE_CENTAVOS = 10_000;

/** Customer location; browse is always relative to it (nearby stores in the customer's zone). */
const nearSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

/** "vegan,halal" or repeated ?dietary= params. */
const dietaryListSchema = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v),
  z.array(dietaryTagSchema).min(1).max(7),
);

const searchTextSchema = z.string().trim().min(1).max(100);

/** Filters on what a store sells; combined, one product must satisfy all of them. */
const productFiltersSchema = z.object({
  dietary: dietaryListSchema.optional(),
  /** Has an item at or under BUDGET_PRICE_CENTAVOS. */
  budget: z.stringbool().optional(),
  /** Has the item (q) — or anything, without q — in stock right now. */
  inStock: z.stringbool().optional(),
});

// ------------------------------------------------------------------ stores

export const storeSortSchema = z.enum(['distance', 'rating', 'prep_time']);
export type StoreSort = z.infer<typeof storeSortSchema>;

export const browseStoresQuerySchema = cursorPageQuerySchema
  .extend(nearSchema.shape)
  .extend(productFiltersSchema.shape)
  .extend({
    /** Store name (typo tolerant) or something it sells. */
    q: searchTextSchema.optional(),
    businessType: businessTypeSchema.optional(),
    /** Store tag slug, e.g. "milk-tea". */
    tag: z
      .string()
      .regex(/^[a-z0-9-]{1,60}$/)
      .optional(),
    openNow: z.stringbool().optional(),
    minRating: z.coerce.number().min(0).max(5).optional(),
    verified: z.stringbool().optional(),
    freeDelivery: z.stringbool().optional(),
    sort: storeSortSchema.default('distance'),
  });
export type BrowseStoresQuery = z.input<typeof browseStoresQuerySchema>;

export const storeListSchema = cursorPageSchema(merchantSummarySchema).extend({
  /** The customer's delivery zone; null = location not serviceable (items is empty). */
  zoneId: idSchema.nullable(),
});
export type StoreList = z.infer<typeof storeListSchema>;

/** Optional ?lat&lng on store pages, for distance. */
export const storeLocationQuerySchema = nearSchema
  .partial()
  .refine(
    (v) => (v.lat === undefined) === (v.lng === undefined),
    'Send both lat and lng, or neither',
  );

export const storeTagSchema = z.object({ slug: z.string(), name: z.string() });

/** Public store page. */
export const publicStoreSchema = merchantSummarySchema.extend({
  description: z.string().nullable(),
  addressLine: z.string(),
  barangay: z.string(),
  city: z.string(),
  location: latLngSchema,
  pauseMessage: z.string().nullable(),
  deliveryRadiusM: z.number().int().positive(),
  advanceOrderHours: z.number().int().nonnegative(),
  avgResponseSeconds: z.number().int().nonnegative().nullable(),
  followerCount: z.number().int().nonnegative(),
  tags: z.array(storeTagSchema),
  weekly: z.array(storeHoursSlotSchema),
  /** Today and later. */
  holidays: z.array(holidayClosureSchema),
});
export type PublicStore = z.infer<typeof publicStoreSchema>;

export const publicCategorySchema = z.object({
  id: idSchema,
  name: z.string(),
  sortOrder: z.number().int(),
  /** Products visible on the menu right now. */
  productCount: z.number().int().positive(),
});
export type PublicCategory = z.infer<typeof publicCategorySchema>;

// ------------------------------------------------------------------ products

/** Menu / search result card. */
export const productCardSchema = z.object({
  id: idSchema,
  merchantId: idSchema,
  categoryId: idSchema.nullable(),
  name: z.string(),
  description: z.string().nullable(),
  /** 200px thumb of the first image. */
  imageUrl: urlSchema.nullable(),
  /** Lowest price a customer can pick (cheapest available variant, else base price). */
  fromPriceCentavos: nonNegativeCentavosSchema,
  compareAtPriceCentavos: nonNegativeCentavosSchema.nullable(),
  dietaryTags: z.array(dietaryTagSchema),
  isSoldOut: z.boolean(),
  isLowStock: z.boolean(),
  /** Has variants or modifier groups: open the detail sheet before adding to cart. */
  hasOptions: z.boolean(),
});
export type ProductCard = z.infer<typeof productCardSchema>;

export const publicVariantSchema = z.object({
  id: idSchema,
  name: z.string(),
  priceCentavos: nonNegativeCentavosSchema,
  isAvailable: z.boolean(),
  isSoldOut: z.boolean(),
  isLowStock: z.boolean(),
});
export type PublicVariant = z.infer<typeof publicVariantSchema>;

/** Product detail as customers see it: no SKU, stock counts or internal flags. */
export const publicProductSchema = z.object({
  id: idSchema,
  merchantId: idSchema,
  categoryId: idSchema.nullable(),
  name: z.string(),
  description: z.string().nullable(),
  images: z.array(productImageSchema),
  basePriceCentavos: nonNegativeCentavosSchema,
  compareAtPriceCentavos: nonNegativeCentavosSchema.nullable(),
  dietaryTags: z.array(dietaryTagSchema),
  isSoldOut: z.boolean(),
  isLowStock: z.boolean(),
  variants: z.array(publicVariantSchema),
  modifierGroups: z.array(modifierGroupSchema),
  /** Wholesale price breaks (supplier/wholesaler stores only). */
  wholesaleTiers: z.array(wholesaleTierSchema),
});
export type PublicProduct = z.infer<typeof publicProductSchema>;

export const storeProductsQuerySchema = cursorPageQuerySchema
  .extend(productFiltersSchema.shape)
  .extend({
    categoryId: idSchema.optional(),
    q: searchTextSchema.optional(),
  });
export type StoreProductsQuery = z.input<typeof storeProductsQuerySchema>;

// ------------------------------------------------------------------ search

export const searchProductsQuerySchema = cursorPageQuerySchema
  .extend(nearSchema.shape)
  .extend(productFiltersSchema.shape)
  .extend({ q: searchTextSchema, openNow: z.stringbool().optional() });
export type SearchProductsQuery = z.input<typeof searchProductsQuerySchema>;

export const productHitSchema = z.object({
  product: productCardSchema,
  store: z.object({
    id: idSchema,
    slug: z.string(),
    name: z.string(),
    logoUrl: urlSchema.nullable(),
    isOpen: z.boolean(),
    distanceMeters: z.number().int().nonnegative(),
  }),
});
export type ProductHit = z.infer<typeof productHitSchema>;

export const searchProductsResultSchema = cursorPageSchema(productHitSchema).extend({
  zoneId: idSchema.nullable(),
});
export type SearchProductsResult = z.infer<typeof searchProductsResultSchema>;

export const MAX_SUGGESTIONS = 5;

export const suggestQuerySchema = nearSchema.extend({ q: z.string().trim().min(1).max(60) });
export type SuggestQuery = z.input<typeof suggestQuerySchema>;

/** Autocomplete: a fixed top-N (MAX_SUGGESTIONS each), not a paginated list. */
export const suggestionsSchema = z.object({
  stores: z
    .array(
      z.object({ id: idSchema, slug: z.string(), name: z.string(), logoUrl: urlSchema.nullable() }),
    )
    .max(MAX_SUGGESTIONS),
  /** Distinct product names to search for. */
  products: z.array(z.string()).max(MAX_SUGGESTIONS),
});
export type Suggestions = z.infer<typeof suggestionsSchema>;
