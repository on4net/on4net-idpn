-- Bind authorization codes and refresh tokens to the Login Context they were issued for
-- (docs/login-contexts.md 5, docs/security.md T31). Nullable: codes/tokens issued before this
-- migration, and flows without a context, keep the client-wide role set.

-- AlterTable
ALTER TABLE "authorization_codes" ADD COLUMN "login_context" VARCHAR(64);

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN "login_context" VARCHAR(64);
