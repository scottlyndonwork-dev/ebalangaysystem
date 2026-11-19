-- DropIndex
DROP INDEX "order_chat_messages_order_id_created_at_idx";

-- AlterTable
ALTER TABLE "order_chat_messages" ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'merchant';

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "removed_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "idempotency_hash" TEXT;

-- CreateIndex
CREATE INDEX "order_chat_messages_order_id_channel_created_at_idx" ON "order_chat_messages"("order_id", "channel", "created_at");
