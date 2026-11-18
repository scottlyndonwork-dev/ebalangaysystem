import type { FastifyInstance } from 'fastify';
import { categoryRoutes } from './categories.js';
import { inventoryRoutes } from './inventory.js';
import { catalogMediaRoutes } from './media.js';
import { productRoutes } from './products.js';

/** /v1/merchants/:merchantId/{categories,products,inventory,menu-schedules,catalog/import}. */
export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  await app.register(categoryRoutes);
  await app.register(productRoutes);
  await app.register(inventoryRoutes);
  await app.register(catalogMediaRoutes);
}
