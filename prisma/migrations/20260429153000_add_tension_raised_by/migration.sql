ALTER TABLE "Tension" ADD COLUMN "raisedByMemberId" TEXT;

CREATE INDEX "Tension_raisedByMemberId_idx" ON "Tension"("raisedByMemberId");

ALTER TABLE "Tension" ADD CONSTRAINT "Tension_raisedByMemberId_fkey" FOREIGN KEY ("raisedByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
