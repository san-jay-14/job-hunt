-- AlterTable: add a short human-friendly id, backfilled for existing rows via SERIAL.
ALTER TABLE "Job" ADD COLUMN "ref" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Job_ref_key" ON "Job"("ref");
