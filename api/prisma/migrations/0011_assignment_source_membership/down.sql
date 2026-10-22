-- Revert the membership ownership of assignments. Rows that differ only by source membership
-- would collide with the 5-column key, so exactly one row per tuple is kept.
--
-- The kept row must be the one that still grants access: a live grant sorts before an expired
-- one, and the newest wins inside each group. Ordering by `created_at` alone kept an expired
-- row over a live one and silently revoked access (card #72 finding 6).

DELETE FROM "assignments" a
 WHERE a."id" NOT IN (
   SELECT DISTINCT ON ("subject_type", "subject_id", "role_id", "scope_type", "scope_id") "id"
     FROM "assignments"
    ORDER BY "subject_type", "subject_id", "role_id", "scope_type", "scope_id",
             ("expires_at" IS NOT NULL AND "expires_at" <= now()) ASC,
             "created_at" DESC,
             "id" DESC
 );

ALTER TABLE "assignments" DROP CONSTRAINT IF EXISTS "assignments_source_membership_id_fkey";

DROP INDEX IF EXISTS "assignments_source_membership_id_idx";

DROP INDEX IF EXISTS "assignments_subject_type_subject_id_role_id_scope_type_scop_key";

ALTER TABLE "assignments" DROP COLUMN IF EXISTS "source_membership_id";

CREATE UNIQUE INDEX "assignments_subject_type_subject_id_role_id_scope_type_scop_key"
  ON "assignments"("subject_type", "subject_id", "role_id", "scope_type", "scope_id")
  NULLS NOT DISTINCT;
