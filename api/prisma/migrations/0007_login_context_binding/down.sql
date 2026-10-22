-- Revert 0007_login_context_binding.
ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "login_context";
ALTER TABLE "authorization_codes" DROP COLUMN IF EXISTS "login_context";
