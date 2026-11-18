import {
  createCategoryInputSchema,
  createMenuScheduleInputSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  menuScheduleSchema,
  productCategorySchema,
  reorderInputSchema,
  updateCategoryInputSchema,
} from '@ebalangay/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Tx, withMerchantContext } from '../../db.js';
import { AppError } from '../../lib/errors.js';
import type { ZodTypeProvider } from '../../lib/zod-provider.js';
import { requireMerchantPermission } from '../../plugins/auth.js';
import { reorder } from './products.js';
import { cursorArgs, pageOf } from './service.js';

const tags = ['catalog'];
const params = z.object({ merchantId: z.uuid() });
const categoryParams = params.extend({ categoryId: z.uuid() });
const scheduleParams = params.extend({ scheduleId: z.uuid() });

const categoryInclude = {
  _count: { select: { products: { where: { deletedAt: null } } } },
} as const;

type CategoryRow = {
  id: string;
  merchantId: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  _count: { products: number };
};

const toCategory = (c: CategoryRow) => ({
  id: c.id,
  merchantId: c.merchantId,
  name: c.name,
  sortOrder: c.sortOrder,
  isActive: c.isActive,
  productCount: c._count.products,
});

type ScheduleRow = {
  id: string;
  name: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  productIds: string[];
  categoryIds: string[];
  isActive: boolean;
};

const toSchedule = (s: ScheduleRow) => ({
  id: s.id,
  name: s.name,
  dayOfWeek: s.dayOfWeek,
  startTime: s.startTime,
  endTime: s.endTime,
  productIds: s.productIds,
  categoryIds: s.categoryIds,
  isActive: s.isActive,
});

async function assertOwnIds(
  tx: Tx,
  merchantId: string,
  productIds: string[],
  categoryIds: string[],
) {
  const products = new Set(productIds);
  const categories = new Set(categoryIds);
  const [p, c] = await Promise.all([
    tx.product.count({ where: { merchantId, deletedAt: null, id: { in: [...products] } } }),
    tx.category.count({ where: { merchantId, id: { in: [...categories] } } }),
  ]);
  if (p !== products.size) throw new AppError('VALIDATION_FAILED', 'Unknown product in schedule');
  if (c !== categories.size)
    throw new AppError('VALIDATION_FAILED', 'Unknown category in schedule');
}

export async function categoryRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ------------------------------------------------------------ categories
  r.get(
    '/:merchantId/categories',
    {
      schema: {
        tags,
        params,
        querystring: cursorPageQuerySchema,
        response: { 200: cursorPageSchema(productCategorySchema) },
      },
      preHandler: requireMerchantPermission(),
    },
    async (req) => {
      const { merchantId } = req.params;
      const { cursor, limit } = req.query;
      return withMerchantContext(app.db, merchantId, async (tx) => {
        const rows = await tx.category.findMany({
          where: { merchantId },
          include: categoryInclude,
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          take: limit + 1,
          ...cursorArgs(cursor),
        });
        const page = pageOf(rows, limit);
        return { items: page.items.map(toCategory), nextCursor: page.nextCursor };
      });
    },
  );

  r.post(
    '/:merchantId/categories',
    {
      schema: {
        tags,
        params,
        body: createCategoryInputSchema,
        response: { 201: productCategorySchema },
      },
      preHandler: requireMerchantPermission('catalog.edit'),
    },
    async (req, reply) => {
      const { merchantId } = req.params;
      const category = await withMerchantContext(app.db, merchantId, async (tx) => {
        let { sortOrder } = req.body;
        if (sortOrder === undefined) {
          const last = await tx.category.aggregate({
            where: { merchantId },
            _max: { sortOrder: true },
          });
          sortOrder = (last._max.sortOrder ?? -1) + 1;
        }
        const c = await tx.category.create({
          data: { ...req.body, sortOrder, merchantId },
          include: categoryInclude,
        });
        return toCategory(c);
      });
      return reply.status(201).send(category);
    },
  );

  r.patch(
    '/:merchantId/categories/:categoryId',
    {
      schema: {
        tags,
        params: categoryParams,
        body: updateCategoryInputSchema,
        response: { 200: productCategorySchema },
      },
      preHandler: requireMerchantPermission('catalog.edit'),
    },
    async (req) => {
      const { merchantId, categoryId } = req.params;
      return withMerchantContext(app.db, merchantId, async (tx) => {
        const { count } = await tx.category.updateMany({
          where: { id: categoryId, merchantId },
          data: req.body,
        });
        if (count === 0) throw new AppError('NOT_FOUND', 'Category not found');
        const c = await tx.category.findUniqueOrThrow({
          where: { id: categoryId },
          include: categoryInclude,
        });
        return toCategory(c);
      });
    },
  );

  /** Products in the category stay, uncategorised. */
  r.delete(
    '/:merchantId/categories/:categoryId',
    {
      schema: { tags, params: categoryParams, response: { 204: z.null() } },
      preHandler: requireMerchantPermission('catalog.edit'),
    },
    async (req, reply) => {
      const { merchantId, categoryId } = req.params;
      await withMerchantContext(app.db, merchantId, async (tx) => {
        const { count } = await tx.category.deleteMany({ where: { id: categoryId, merchantId } });
        if (count === 0) throw new AppError('NOT_FOUND', 'Category not found');
        await tx.$executeRaw`
          UPDATE menu_schedules SET category_ids = array_remove(category_ids, ${categoryId}::uuid)
          WHERE merchant_id = ${merchantId}::uuid AND ${categoryId}::uuid = ANY(category_ids)`;
      });
      return reply.status(204).send(null);
    },
  );

  r.put(
    '/:merchantId/categories/order',
    {
      schema: { tags, params, body: reorderInputSchema, response: { 204: z.null() } },
      preHandler: requireMerchantPermission('catalog.edit'),
    },
    async (req, reply) => {
      const { merchantId } = req.params;
      await withMerchantContext(app.db, merchantId, (tx) =>
        reorder(tx, 'category', merchantId, req.body.ids),
      );
      return reply.status(204).send(null);
    },
  );

  // ------------------------------------------------------------ menu schedules
  r.get(
    '/:merchantId/menu-schedules',
    {
      schema: {
        tags,
        params,
        querystring: cursorPageQuerySchema,
        response: { 200: cursorPageSchema(menuScheduleSchema) },
      },
      preHandler: requireMerchantPermission(),
    },
    async (req) => {
      const { merchantId } = req.params;
      const { cursor, limit } = req.query;
      return withMerchantContext(app.db, merchantId, async (tx) => {
        const rows = await tx.menuSchedule.findMany({
          where: { merchantId },
          orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }, { id: 'asc' }],
          take: limit + 1,
          ...cursorArgs(cursor),
        });
        const page = pageOf(rows, limit);
        return { items: page.items.map(toSchedule), nextCursor: page.nextCursor };
      });
    },
  );

  r.post(
    '/:merchantId/menu-schedules',
    {
      schema: {
        tags,
        params,
        body: createMenuScheduleInputSchema,
        response: { 201: menuScheduleSchema },
      },
      preHandler: requireMerchantPermission('catalog.edit'),
    },
    async (req, reply) => {
      const { merchantId } = req.params;
      const body = req.body;
      const s = await withMerchantContext(app.db, merchantId, async (tx) => {
        await assertOwnIds(tx, merchantId, body.productIds, body.categoryIds);
        return tx.menuSchedule.create({
          data: {
            ...body,
            productIds: [...new Set(body.productIds)],
            categoryIds: [...new Set(body.categoryIds)],
            merchantId,
          },
        });
      });
      return reply.status(201).send(toSchedule(s));
    },
  );

  r.put(
    '/:merchantId/menu-schedules/:scheduleId',
    {
      schema: {
        tags,
        params: scheduleParams,
        body: createMenuScheduleInputSchema,
        response: { 200: menuScheduleSchema },
      },
      preHandler: requireMerchantPermission('catalog.edit'),
    },
    async (req) => {
      const { merchantId, scheduleId } = req.params;
      const body = req.body;
      return withMerchantContext(app.db, merchantId, async (tx) => {
        await assertOwnIds(tx, merchantId, body.productIds, body.categoryIds);
        const { count } = await tx.menuSchedule.updateMany({
          where: { id: scheduleId, merchantId },
          data: {
            ...body,
            productIds: [...new Set(body.productIds)],
            categoryIds: [...new Set(body.categoryIds)],
          },
        });
        if (count === 0) throw new AppError('NOT_FOUND', 'Menu schedule not found');
        return toSchedule(await tx.menuSchedule.findUniqueOrThrow({ where: { id: scheduleId } }));
      });
    },
  );

  r.delete(
    '/:merchantId/menu-schedules/:scheduleId',
    {
      schema: { tags, params: scheduleParams, response: { 204: z.null() } },
      preHandler: requireMerchantPermission('catalog.edit'),
    },
    async (req, reply) => {
      const { merchantId, scheduleId } = req.params;
      await withMerchantContext(app.db, merchantId, async (tx) => {
        const { count } = await tx.menuSchedule.deleteMany({
          where: { id: scheduleId, merchantId },
        });
        if (count === 0) throw new AppError('NOT_FOUND', 'Menu schedule not found');
      });
      return reply.status(204).send(null);
    },
  );
}
