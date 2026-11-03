-- Record the Login Context an IdP session was established for (docs/login-contexts.md 3.4,
-- docs/auth-flows.md 2.5). Nullable on purpose: sessions created before this migration and
-- client-wide (unbound) sessions keep `login_context IS NULL` and stay valid.

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "login_context" VARCHAR(64);

-- CreateIndex
CREATE INDEX "sessions_client_id_login_context_idx" ON "sessions"("client_id", "login_context");
