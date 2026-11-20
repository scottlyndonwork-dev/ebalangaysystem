-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "released_at" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "orders_released_at_scheduled_for_idx" ON "orders"("released_at", "scheduled_for");
