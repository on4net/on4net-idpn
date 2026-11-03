-- The unique tuple of an assignment must also hold when scope_id IS NULL (scope_type=global).
-- Without NULLS NOT DISTINCT PostgreSQL treats every global assignment as distinct, which
-- allows the same role to be assigned twice to the same subject.
DROP INDEX IF EXISTS "assignments_subject_type_subject_id_role_id_scope_type_scop_key";

CREATE UNIQUE INDEX "assignments_subject_type_subject_id_role_id_scope_type_scop_key"
  ON "assignments"("subject_type", "subject_id", "role_id", "scope_type", "scope_id")
  NULLS NOT DISTINCT;
