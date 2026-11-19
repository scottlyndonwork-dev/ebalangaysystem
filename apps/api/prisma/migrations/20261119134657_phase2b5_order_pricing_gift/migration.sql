-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "delivery_discount_centavos" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "gift_hide_prices" BOOLEAN NOT NULL DEFAULT false;
