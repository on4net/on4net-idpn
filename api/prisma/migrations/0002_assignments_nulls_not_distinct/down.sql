DROP INDEX IF EXISTS "assignments_subject_type_subject_id_role_id_scope_type_scop_key";

CREATE UNIQUE INDEX "assignments_subject_type_subject_id_role_id_scope_type_scop_key"
  ON "assignments"("subject_type", "subject_id", "role_id", "scope_type", "scope_id");
