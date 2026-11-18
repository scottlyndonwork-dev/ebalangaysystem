import {
  CATALOG_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  type DietaryTag,
  type ImportRowError,
  dietaryTagSchema,
  pesosToCentavos,
} from '@ebalangay/shared';
import { parse } from 'csv-parse/sync';
import type { Tx } from '../../db.js';
import { ensureLevels } from './products.js';
import { changeStock, syncKeyProductAutoPause } from './service.js';

type Column = (typeof CATALOG_IMPORT_COLUMNS)[number];
const KNOWN = new Set<string>(CATALOG_IMPORT_COLUMNS);

/** Parsed row; undefined = cell absent/empty (keep existing value on update, default on create). */
interface ImportRow {
  line: number;
  name?: string;
  priceCentavos?: number;
  sku?: string;
  category?: string;
  description?: string;
  compareAtPriceCentavos?: number;
  isAvailable?: boolean;
  isKey?: boolean;
  dietaryTags?: DietaryTag[];
  trackInventory?: boolean;
  stock?: number;
  /** Existing product matched by SKU. */
  existingId?: string;
}

export interface ImportPlan {
  rows: ImportRow[];
  newCategories: string[];
  errors: ImportRowError[];
  summary: { rowCount: number; created: number; updated: number; categoriesCreated: number };
}

const BOOL: Record<string, boolean> = {
  true: true,
  false: false,
  yes: true,
  no: false,
  y: true,
  n: false,
  '1': true,
  '0': false,
};

const LIMITS: Partial<Record<Column, number>> = {
  name: 120,
  sku: 64,
  category: 80,
  description: 2000,
};

function parseRow(record: Record<string, string>, line: number, errors: ImportRowError[]) {
  const row: ImportRow = { line };
  const fail = (column: Column, message: string) => errors.push({ line, column, message });
  const cell = (c: Column) => {
    const v = record[c]?.trim();
    if (!v) return undefined;
    const max = LIMITS[c];
    if (max && v.length > max) {
      fail(c, `Too long (max ${max} characters)`);
      return undefined;
    }
    return v;
  };
  const money = (c: Column) => {
    const v = cell(c);
    if (v === undefined) return undefined;
    try {
      const n = pesosToCentavos(v.replace(/^₱/, ''));
      if (n < 0) throw new Error();
      return n;
    } catch {
      fail(c, 'Use a peso amount like 120 or 120.50');
      return undefined;
    }
  };
  const bool = (c: Column) => {
    const v = cell(c);
    if (v === undefined) return undefined;
    const b = BOOL[v.toLowerCase()];
    if (b === undefined) fail(c, 'Use true or false');
    return b;
  };

  row.name = cell('name');
  row.priceCentavos = money('price');
  row.sku = cell('sku');
  row.category = cell('category');
  row.description = cell('description');
  row.compareAtPriceCentavos = money('compare_at_price');
  row.isAvailable = bool('available');
  row.isKey = bool('is_key');
  row.trackInventory = bool('track_inventory');

  const tags = cell('dietary_tags');
  if (tags !== undefined) {
    const parts = [
      ...new Set(
        tags
          .split(/[|;]/)
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    const bad = parts.filter((t) => !dietaryTagSchema.safeParse(t).success);
    if (bad.length) fail('dietary_tags', `Unknown tag(s): ${bad.join(', ')}`);
    else row.dietaryTags = parts as DietaryTag[];
  }
  const stock = cell('stock');
  if (stock !== undefined) {
    if (!/^\d{1,7}$/.test(stock)) fail('stock', 'Use a whole number 0 or more');
    else row.stock = Number(stock);
  }
  return row;
}

/** Parse + validate everything against the current catalog. Never writes. */
export async function parseImport(tx: Tx, merchantId: string, csv: Buffer): Promise<ImportPlan> {
  const errors: ImportRowError[] = [];
  const empty: ImportPlan = {
    rows: [],
    newCategories: [],
    errors,
    summary: { rowCount: 0, created: 0, updated: 0, categoriesCreated: 0 },
  };

  let records: Record<string, string>[];
  try {
    records = parse(csv, {
      bom: true,
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
      skip_empty_lines: true,
      relax_quotes: false,
      to_line: MAX_IMPORT_ROWS + 2,
    }) as Record<string, string>[];
  } catch (err) {
    const line = (err as { lines?: number }).lines ?? 1;
    errors.push({ line, column: null, message: `Unreadable CSV: ${(err as Error).message}` });
    return empty;
  }

  const header = Object.keys(records[0] ?? {});
  const unknown = header.filter((h) => !KNOWN.has(h));
  if (unknown.length) {
    errors.push({ line: 1, column: null, message: `Unknown column(s): ${unknown.join(', ')}` });
  }
  if (records.length === 0) {
    errors.push({ line: 1, column: null, message: 'The file has no product rows' });
  }
  if (records.length > MAX_IMPORT_ROWS) {
    errors.push({ line: 1, column: null, message: `At most ${MAX_IMPORT_ROWS} rows per file` });
  }
  if (errors.length) return empty;

  // Line numbers assume one physical line per record (true unless cells contain newlines).
  const rows = records.map((rec, i) => parseRow(rec, i + 2, errors));

  const skus = rows.flatMap((r) => (r.sku ? [r.sku] : []));
  const existing = skus.length
    ? await tx.product.findMany({
        where: { merchantId, deletedAt: null, sku: { in: skus } },
        select: {
          id: true,
          sku: true,
          trackInventory: true,
          _count: { select: { variants: true } },
        },
      })
    : [];
  const bySku = new Map<string, typeof existing>();
  for (const p of existing) {
    if (p.sku) bySku.set(p.sku, [...(bySku.get(p.sku) ?? []), p]);
  }

  const seen = new Map<string, number>();
  for (const row of rows) {
    const { line } = row;
    const match = row.sku ? bySku.get(row.sku) : undefined;
    if (row.sku) {
      const first = seen.get(row.sku);
      if (first !== undefined) {
        errors.push({ line, column: 'sku', message: `Duplicate SKU (also on line ${first})` });
      } else seen.set(row.sku, line);
      if (match && match.length > 1) {
        errors.push({ line, column: 'sku', message: 'SKU matches more than one product' });
      }
    }
    const product = match?.length === 1 ? match[0] : undefined;
    row.existingId = product?.id;
    if (!product) {
      if (row.name === undefined) errors.push({ line, column: 'name', message: 'Required' });
      if (row.priceCentavos === undefined) {
        errors.push({ line, column: 'price', message: 'Required' });
      }
    }
    if (row.stock !== undefined) {
      const tracked = row.trackInventory ?? product?.trackInventory ?? false;
      if (!tracked) {
        errors.push({ line, column: 'stock', message: 'Set track_inventory to true to set stock' });
      }
      if (product && product._count.variants > 0) {
        errors.push({
          line,
          column: 'stock',
          message: 'This product has variants; set stock per variant in the app',
        });
      }
    }
  }

  const categories = await tx.category.findMany({ where: { merchantId }, select: { name: true } });
  const have = new Set(categories.map((c) => c.name.toLowerCase()));
  const newCategories = new Map<string, string>();
  for (const r of rows) {
    const key = r.category?.toLowerCase();
    if (r.category && key && !have.has(key) && !newCategories.has(key)) {
      newCategories.set(key, r.category);
    }
  }

  errors.sort((a, b) => a.line - b.line);
  const updated = rows.filter((r) => r.existingId).length;
  return {
    rows,
    newCategories: [...newCategories.values()],
    errors,
    summary: {
      rowCount: rows.length,
      created: rows.length - updated,
      updated,
      categoriesCreated: newCategories.size,
    },
  };
}

/** Writes a validated plan. Runs in the caller's transaction, so it is all-or-nothing. */
export async function applyImport(
  tx: Tx,
  merchantId: string,
  plan: ImportPlan,
  actorUserId: string,
): Promise<void> {
  const last = await tx.category.aggregate({ where: { merchantId }, _max: { sortOrder: true } });
  let catOrder = (last._max.sortOrder ?? -1) + 1;
  for (const name of plan.newCategories) {
    await tx.category.create({ data: { merchantId, name, sortOrder: catOrder++ } });
  }
  const cats = await tx.category.findMany({
    where: { merchantId },
    select: { id: true, name: true },
  });
  const catId = new Map<string, string>();
  // Oldest wins when two categories differ only by case.
  for (const c of cats.reverse()) catId.set(c.name.toLowerCase(), c.id);

  const lastProduct = await tx.product.aggregate({
    where: { merchantId, deletedAt: null },
    _max: { sortOrder: true },
  });
  let productOrder = (lastProduct._max.sortOrder ?? -1) + 1;

  for (const row of plan.rows) {
    const data = {
      ...(row.name !== undefined ? { name: row.name } : {}),
      ...(row.priceCentavos !== undefined ? { basePriceCentavos: BigInt(row.priceCentavos) } : {}),
      ...(row.sku !== undefined ? { sku: row.sku } : {}),
      ...(row.category !== undefined
        ? { categoryId: catId.get(row.category.toLowerCase()) ?? null }
        : {}),
      ...(row.description !== undefined ? { description: row.description } : {}),
      ...(row.compareAtPriceCentavos !== undefined
        ? { compareAtPriceCentavos: BigInt(row.compareAtPriceCentavos) }
        : {}),
      ...(row.isAvailable !== undefined ? { isAvailable: row.isAvailable } : {}),
      ...(row.isKey !== undefined ? { isKey: row.isKey } : {}),
      ...(row.dietaryTags !== undefined ? { dietaryTags: row.dietaryTags } : {}),
      ...(row.trackInventory !== undefined ? { trackInventory: row.trackInventory } : {}),
    };
    const productId = row.existingId
      ? (
          await tx.product.update({
            where: { id: row.existingId },
            data: { ...data, version: { increment: 1 } },
          })
        ).id
      : (
          await tx.product.create({
            data: {
              ...data,
              merchantId,
              name: row.name ?? '',
              basePriceCentavos: BigInt(row.priceCentavos ?? 0),
              sortOrder: productOrder++,
            },
          })
        ).id;
    await ensureLevels(tx, merchantId, productId);
    if (row.stock !== undefined) {
      await changeStock(tx, {
        merchantId,
        productId,
        variantId: null,
        mode: 'set',
        quantity: row.stock,
        reason: 'adjustment',
        note: 'CSV import',
        actorUserId,
      });
    }
  }
  await syncKeyProductAutoPause(tx, merchantId);
}
