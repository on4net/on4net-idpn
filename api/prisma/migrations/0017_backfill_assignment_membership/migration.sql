-- 0011 added `assignments.source_membership_id` but never filled it, so every grant created
-- before it stayed unowned and two memberships could still share (and delete) one row
-- (card #72 finding 2).
--
-- Only unambiguous grants are attributed: the assignment must belong to a user, the role must
-- belong to the membership's client, the membership's context must allow the role, and exactly
-- one active membership must match. Anything ambiguous is left for the next removal, which now
-- attributes covered rows instead of deleting them.

WITH candidates AS (
  SELECT a."id" AS assignment_id,
         m."id" AS membership_id,
         count(*) OVER (PARTITION BY a."id") AS candidate_count
    FROM "assignments" a
    JOIN "client_memberships" m
      ON m."user_id" = a."subject_id"
     AND m."status" = 'active'
    JOIN "client_login_contexts" c
      ON c."id" = m."login_context_id"
    JOIN "roles" r
      ON r."id" = a."role_id"
   WHERE a."source_membership_id" IS NULL
     AND a."subject_type" = 'user'
     AND r."client_id" = m."client_id"
     AND r."key" = ANY(c."allowed_roles")
)
UPDATE "assignments" a
   SET "source_membership_id" = candidates."membership_id"
  FROM candidates
 WHERE candidates."assignment_id" = a."id"
   AND candidates."candidate_count" = 1;
