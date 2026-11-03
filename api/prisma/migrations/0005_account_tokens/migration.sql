-- Single-use account lifecycle tokens (docs/auth-flows.md 8.2-8.4).
-- The emailed token is never stored: only its SHA-256 digest, the owning user, the purpose
-- and the expiry. Consumption is a conditional update, so a token can be used exactly once.

-- CreateEnum
CREATE TYPE "AccountTokenPurpose" AS ENUM ('invite', 'email_verification', 'password_reset');

-- CreateTable
CREATE TABLE "account_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "purpose" "AccountTokenPurpose" NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_tokens_token_hash_key" ON "account_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "account_tokens_user_id_purpose_consumed_at_idx" ON "account_tokens"("user_id", "purpose", "consumed_at");

-- CreateIndex
CREATE INDEX "account_tokens_expires_at_idx" ON "account_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
