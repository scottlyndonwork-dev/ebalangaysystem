/** Turns cart selections (ids + quantities) into priced, validated lines from live catalog data. */
import { isVisibleOnMenu } from '@ebalangay/shared';
import type { Db, Tx } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { loadSchedules } from '../browse/service.js';
import { productInclude } from '../catalog/service.js';
import type { PricingLineInput } from '../pricing/engine.js';

export interface LineSelection {
  /** Cart item id (or index for POS); echoed back. */
  key: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  modifierOptionIds: readonly string[];
  notes: string | null;
  memberId?: string | null;
}

export type LineProblem =
  | 'PRODUCT_UNAVAILABLE'
  | 'NOT_ON_MENU'
  | 'VARIANT_REQUIRED'
  | 'VARIANT_INVALID'
  | 'VARIANT_UNAVAILABLE'
  | 'MODIFIER_INVALID'
  | 'MODIFIER_UNAVAILABLE'
  | 'MODIFIER_COUNT'
  | 'OUT_OF_STOCK';

export const LINE_PROBLEM_MESSAGES: Record<LineProblem, string> = {
  PRODUCT_UNAVAILABLE: 'This item is no longer available',
  NOT_ON_MENU: 'This item is not on the menu right now',
  VARIANT_REQUIRED: 'Choose an option for this item',
  VARIANT_INVALID: 'That option does not belong to this item',
  VARIANT_UNAVAILABLE: 'That option is no longer available',
  MODIFIER_INVALID: 'An add-on does not belong to this item',
  MODIFIER_UNAVAILABLE: 'An add-on is no longer available',
  MODIFIER_COUNT: 'Pick the required number of add-ons',
  OUT_OF_STOCK: 'Not enough stock for this item',
};

export interface ResolvedModifier {
  id: string;
  name: string;
  priceDeltaCentavos: number;
}

export interface ResolvedLine {
  selection: LineSelection;
  problem: LineProblem | null;
  name: string;
  variantName: string | null;
  imageUrl: string | null;
  modifiers: ResolvedModifier[];
  trackInventory: boolean;
  /** Input to priceOrder; only lines without a problem are priced. */
  pricing: PricingLineInput;
}

const lineInclude = {
  ...productInclude,
  category: { select: { isActive: true } },
} satisfies Prisma.ProductInclude;
type LineProduct = Prisma.ProductGetPayload<{ include: typeof lineInclude }>;
type Schedules = Awaited<ReturnType<Awaited<ReturnType<typeof loadSchedules>>>>;

const stockKey = (productId: string, variantId: string | null) => `${productId}|${variantId ?? ''}`;

function resolveOne(
  p: LineProduct | undefined,
  sel: LineSelection,
  schedules: Schedules,
  now: Date,
): ResolvedLine {
  const out: ResolvedLine = {
    selection: sel,
    problem: null,
    name: p?.name ?? 'Unavailable item',
    variantName: null,
    imageUrl: p ? (p.images[0]?.thumbUrl ?? p.images[0]?.url ?? null) : null,
    modifiers: [],
    trackInventory: p?.trackInventory ?? false,
    pricing: {
      key: sel.key,
      unitPriceCentavos: p ? Number(p.basePriceCentavos) : 0,
      modifierDeltasCentavos: [],
      quantity: sel.quantity,
    },
  };
  const fail = (problem: LineProblem) => {
    out.problem = problem;
    return out;
  };
  if (!p || p.deletedAt || !p.isAvailable || (p.category && !p.category.isActive)) {
    return fail('PRODUCT_UNAVAILABLE');
  }

  // Variant
  if (p.variants.length) {
    if (!sel.variantId) return fail('VARIANT_REQUIRED');
    const v = p.variants.find((x) => x.id === sel.variantId);
    if (!v) return fail('VARIANT_INVALID');
    out.variantName = v.name;
    out.pricing.unitPriceCentavos = Number(v.priceCentavos);
    if (!v.isAvailable) return fail('VARIANT_UNAVAILABLE');
  } else if (sel.variantId) {
    return fail('VARIANT_INVALID');
  }
  out.pricing.wholesaleTiers = p.wholesalePrices
    .filter((w) => w.variantId === sel.variantId)
    .map((w) => ({ minQty: w.minQty, unitPriceCentavos: Number(w.unitPriceCentavos) }));

  // Modifiers: every option must belong to this product; each group's min/max must hold.
  const chosen = new Set(sel.modifierOptionIds);
  if (chosen.size !== sel.modifierOptionIds.length) return fail('MODIFIER_INVALID');
  let matched = 0;
  let unavailable = false;
  for (const g of p.modifierGroups) {
    const picked = g.modifiers.filter((m) => chosen.has(m.id));
    matched += picked.length;
    for (const m of picked) {
      if (!m.isAvailable) unavailable = true;
      out.modifiers.push({
        id: m.id,
        name: m.name,
        priceDeltaCentavos: Number(m.priceDeltaCentavos),
      });
    }
    if (picked.length < g.minSelect || picked.length > g.maxSelect)
      out.problem ??= 'MODIFIER_COUNT';
  }
  out.pricing.modifierDeltasCentavos = out.modifiers.map((m) => m.priceDeltaCentavos);
  if (matched !== chosen.size) return fail('MODIFIER_INVALID');
  if (unavailable) return fail('MODIFIER_UNAVAILABLE');
  if (out.problem) return out;

  if (!isVisibleOnMenu(p, schedules, now)) return fail('NOT_ON_MENU');
  return out;
}

/**
 * Validate and price selections against the live catalog. Stock is checked across lines (two
 * lines of the same product/variant share one stock level).
 */
export async function resolveLines(
  db: Db | Tx,
  merchantId: string,
  selections: readonly LineSelection[],
  now: Date,
): Promise<ResolvedLine[]> {
  const ids = [...new Set(selections.map((s) => s.productId))];
  const rows = ids.length
    ? await db.product.findMany({ where: { id: { in: ids }, merchantId }, include: lineInclude })
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const schedules = (await loadSchedules(db, [merchantId]))(merchantId);
  const lines = selections.map((sel) => resolveOne(byId.get(sel.productId), sel, schedules, now));

  const wanted = new Map<string, number>();
  for (const l of lines) {
    if (l.problem || !l.trackInventory) continue;
    const k = stockKey(l.selection.productId, l.selection.variantId);
    wanted.set(k, (wanted.get(k) ?? 0) + l.selection.quantity);
  }
  for (const l of lines) {
    if (l.problem || !l.trackInventory) continue;
    const { productId, variantId } = l.selection;
    const level = byId.get(productId)?.inventoryLevels.find((x) => x.variantId === variantId);
    if ((wanted.get(stockKey(productId, variantId)) ?? 0) > (level?.quantity ?? 0)) {
      l.problem = 'OUT_OF_STOCK';
    }
  }
  return lines;
}

/** Same product, variant, add-ons, notes and member → one line (quantities add up). */
export function sameSelection(
  a: Pick<LineSelection, 'productId' | 'variantId' | 'modifierOptionIds' | 'notes' | 'memberId'>,
  b: Pick<LineSelection, 'productId' | 'variantId' | 'modifierOptionIds' | 'notes' | 'memberId'>,
): boolean {
  const mods = (x: readonly string[]) => [...x].sort().join(',');
  return (
    a.productId === b.productId &&
    (a.variantId ?? null) === (b.variantId ?? null) &&
    mods(a.modifierOptionIds) === mods(b.modifierOptionIds) &&
    (a.notes ?? null) === (b.notes ?? null) &&
    (a.memberId ?? null) === (b.memberId ?? null)
  );
}
