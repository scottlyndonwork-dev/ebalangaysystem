-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "application_review_note" TEXT,
ADD COLUMN     "application_reviewed_at" TIMESTAMPTZ(3);
