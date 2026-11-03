-- Revert 0009_session_login_context.
DROP INDEX IF EXISTS "sessions_client_id_login_context_idx";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "login_context";
