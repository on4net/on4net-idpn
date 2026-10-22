-- This migration only attributes rows whose owner was unambiguous. A rollback cannot tell a
-- backfilled row from one written afterwards, and clearing `source_membership_id` would make
-- those grants deletable by an unrelated membership removal again, so the down path is a
-- deliberate no-op.
SELECT 1;
