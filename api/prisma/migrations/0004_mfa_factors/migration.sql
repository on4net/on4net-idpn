-- MFA factors and one-time recovery codes (docs/domain-model.md 2.4, docs/auth-flows.md 7).
-- The TOTP secret is stored only as an AES-256-GCM envelope; recovery codes only as Argon2id
-- hashes. Neither column is ever returned to a client after enrollment.

-- CreateEnum
CREATE TYPE "MfaFactorType" AS ENUM ('totp', 'webauthn');

-- CreateTable
CREATE TABLE "mfa_factors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "type" "MfaFactorType" NOT NULL,
    "name" VARCHAR(64) NOT NULL DEFAULT 'authenticator',
    "secret_encrypted" BYTEA,
    "credential_id" BYTEA,
    "public_key" BYTEA,
    "sign_count" BIGINT NOT NULL DEFAULT 0,
    "confirmed_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "last_used_step" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "factor_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mfa_factors_user_id_type_idx" ON "mfa_factors"("user_id", "type");

-- CreateIndex
CREATE INDEX "mfa_recovery_codes_factor_id_used_at_idx" ON "mfa_recovery_codes"("factor_id", "used_at");

-- AddForeignKey
ALTER TABLE "mfa_factors" ADD CONSTRAINT "mfa_factors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_factor_id_fkey" FOREIGN KEY ("factor_id") REFERENCES "mfa_factors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A user has at most one TOTP factor (WebAuthn authenticators are many). Prisma cannot
-- express a partial unique index, so it is declared here.
CREATE UNIQUE INDEX "mfa_factors_one_totp_per_user"
    ON "mfa_factors" ("user_id")
    WHERE "type" = 'totp';
