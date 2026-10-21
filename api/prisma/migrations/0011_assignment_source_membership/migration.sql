-- An assignment is owned by the membership that granted it (docs/domain-model.md 2.11,
-- docs/login-contexts.md 5). Two contexts of one client may both allow the same role: each
-- membership gets its own row, and removing one membership no longer revokes the grant that
-- the sibling context owns. Rows written before this migration keep NULL and are still
-- cleaned up by the governed role set.

-- AlterTable
ALTER TABLE "assignments" ADD COLUMN "source_membership_id" UUID;

-- DropIndex: the uniqueness key must distinguish the granting membership.
DROP INDEX IF EXISTS "assignments_subject_type_subject_id_role_id_scope_type_scop_key";

-- CreateIndex
CREATE UNIQUE INDEX "assignments_subject_type_subject_id_role_id_scope_type_scop_key"
  ON "assignments"("subject_type", "subject_id", "role_id", "scope_type", "scope_id", "source_membership_id")
  NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "assignments_source_membership_id_idx" ON "assignments"("source_membership_id");

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_source_membership_id_fkey"
  FOREIGN KEY ("source_membership_id") REFERENCES "client_memberships"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
