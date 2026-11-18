/*
  Warnings:

  - A unique constraint covering the columns `[customer_id,idempotency_key]` on the table `orders` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "group_cart_members" ADD COLUMN     "amount_due_centavos" BIGINT;

-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "advance_order_hours" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "application_submitted_at" TIMESTAMPTZ(3),
ADD COLUMN     "auto_paused_at" TIMESTAMPTZ(3),
ADD COLUMN     "auto_paused_reason" TEXT,
ADD COLUMN     "avg_response_seconds" INTEGER,
ADD COLUMN     "free_delivery" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pause_message" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "cancellation_compensation_centavos" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "donation_centavos" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "merchant_net_centavos" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "points_value_centavos" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "prep_time_minutes" INTEGER,
ADD COLUMN     "preparing_at" TIMESTAMPTZ(3),
ADD COLUMN     "rider_earning_centavos" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "wallet_applied_centavos" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "product_images" ADD COLUMN     "display_url" TEXT,
ADD COLUMN     "thumb_url" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "dietary_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "is_key" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "search_tsv" tsvector;

-- CreateTable
CREATE TABLE "merchant_customer_blocks" (
    "merchant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_customer_blocks_pkey" PRIMARY KEY ("merchant_id","user_id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "merchant_customer_blocks_user_id_idx" ON "merchant_customer_blocks"("user_id");

-- CreateIndex
CREATE INDEX "merchants_status_zone_id_idx" ON "merchants"("status", "zone_id");

-- CreateIndex
CREATE INDEX "merchants_verified_badge_idx" ON "merchants"("verified_badge");

-- CreateIndex
CREATE INDEX "merchants_free_delivery_idx" ON "merchants"("free_delivery");

-- CreateIndex
CREATE INDEX "merchants_rating_average_idx" ON "merchants"("rating_average");

-- CreateIndex
CREATE INDEX "orders_merchant_id_placed_at_idx" ON "orders"("merchant_id", "placed_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_customer_id_idempotency_key_key" ON "orders"("customer_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "products_merchant_id_base_price_centavos_idx" ON "products"("merchant_id", "base_price_centavos");

-- CreateIndex
CREATE INDEX "products_dietary_tags_idx" ON "products" USING GIN ("dietary_tags");

-- CreateIndex
CREATE INDEX "products_search_tsv_idx" ON "products" USING GIN ("search_tsv");

-- AddForeignKey
ALTER TABLE "merchant_customer_blocks" ADD CONSTRAINT "merchant_customer_blocks_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_customer_blocks" ADD CONSTRAINT "merchant_customer_blocks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =========================================================================================
-- Raw SQL (appended by hand; Prisma's diff ignores triggers, CHECKs and policies).
-- =========================================================================================

-- Product search vector. 'simple' config: catalog text mixes en/fil/ceb, so no English stemming.
CREATE OR REPLACE FUNCTION eb_sync_product_search() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('simple', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.description, '')), 'B');
  RETURN NEW;
END $$;

CREATE TRIGGER products_sync_search BEFORE INSERT OR UPDATE OF name, description ON products
  FOR EACH ROW EXECUTE FUNCTION eb_sync_product_search();

UPDATE products SET name = name;

ALTER TABLE merchants ADD CONSTRAINT merchants_advance_order_hours_nonneg CHECK (advance_order_hours >= 0);
ALTER TABLE orders ADD CONSTRAINT orders_new_money_nonneg CHECK (
  donation_centavos >= 0 AND points_value_centavos >= 0 AND wallet_applied_centavos >= 0
  AND merchant_net_centavos >= 0 AND rider_earning_centavos >= 0
  AND cancellation_compensation_centavos >= 0
);

-- RLS for the new merchant-scoped table (same policy as the 2A merchant tables).
ALTER TABLE merchant_customer_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_customer_blocks FORCE ROW LEVEL SECURITY;
CREATE POLICY merchant_isolation ON merchant_customer_blocks
  USING (app_current_merchant_id() IS NULL OR merchant_id = app_current_merchant_id())
  WITH CHECK (app_current_merchant_id() IS NULL OR merchant_id = app_current_merchant_id());
