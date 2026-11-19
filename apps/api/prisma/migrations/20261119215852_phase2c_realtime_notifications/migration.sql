/*
  Warnings:

  - A unique constraint covering the columns `[user_id,dedupe_key]` on the table `notifications` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "dedupe_key" TEXT;

-- CreateTable
CREATE TABLE "notification_preferences" (
    "user_id" UUID NOT NULL,
    "category" "NotificationType" NOT NULL,
    "push" BOOLEAN NOT NULL DEFAULT true,
    "sms" BOOLEAN NOT NULL DEFAULT true,
    "in_app" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id","category")
);

-- CreateTable
CREATE TABLE "delivery_breadcrumbs" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "rider_id" UUID NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracy_m" DOUBLE PRECISION,
    "speed_mps" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "delivery_breadcrumbs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_breadcrumbs_delivery_id_recorded_at_idx" ON "delivery_breadcrumbs"("delivery_id", "recorded_at");

-- CreateIndex
CREATE INDEX "delivery_breadcrumbs_rider_id_recorded_at_idx" ON "delivery_breadcrumbs"("rider_id", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_key" ON "notifications"("user_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_breadcrumbs" ADD CONSTRAINT "delivery_breadcrumbs_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_breadcrumbs" ADD CONSTRAINT "delivery_breadcrumbs_rider_id_fkey" FOREIGN KEY ("rider_id") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Analytics: per-merchant daily rollup (Asia/Manila days), refreshed nightly 00:00 PHT by the
-- analytics worker with REFRESH MATERIALIZED VIEW CONCURRENTLY (needs the unique index).
-- Materialized views can't carry RLS: readers must always filter by merchant_id.
CREATE MATERIALIZED VIEW mv_merchant_daily_sales AS
SELECT
  o.merchant_id,
  (o.placed_at AT TIME ZONE 'Asia/Manila')::date AS day,
  count(*)::int AS orders_count,
  count(*) FILTER (WHERE o.status = 'delivered')::int AS delivered_count,
  count(*) FILTER (WHERE o.status IN ('cancelled', 'failed'))::int AS cancelled_count,
  coalesce(sum(o.subtotal_centavos) FILTER (WHERE o.status = 'delivered'), 0)::bigint AS subtotal_centavos,
  coalesce(sum(o.total_centavos) FILTER (WHERE o.status = 'delivered'), 0)::bigint AS gross_centavos,
  coalesce(sum(o.commission_centavos) FILTER (WHERE o.status = 'delivered'), 0)::bigint AS commission_centavos
FROM orders o
WHERE o.placed_at IS NOT NULL
GROUP BY o.merchant_id, (o.placed_at AT TIME ZONE 'Asia/Manila')::date
WITH DATA;

CREATE UNIQUE INDEX mv_merchant_daily_sales_pk ON mv_merchant_daily_sales (merchant_id, day);
CREATE INDEX mv_merchant_daily_sales_day ON mv_merchant_daily_sales (day);
