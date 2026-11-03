-- WebAuthn/passkey credentials (docs/domain-model.md 2.4, docs/auth-flows.md 7.2, docs/security.md 3.3).
-- A credential is stored on the existing MFA factor row (`type = 'webauthn'`) so one user can
-- have a TOTP factor and any number of passkeys. The credential id is globally unique: an
-- authenticator credential must never be enrolled for two accounts.

-- AlterTable
ALTER TABLE "mfa_factors"
    ADD COLUMN "transports" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "aaguid" UUID,
    ADD COLUMN "device_type" VARCHAR(16),
    ADD COLUMN "backed_up" BOOLEAN NOT NULL DEFAULT false;

-- A WebAuthn factor must carry its credential id and public key; a TOTP factor must not.
ALTER TABLE "mfa_factors"
    ADD CONSTRAINT "mfa_factors_webauthn_fields_check" CHECK (
        ("type" = 'webauthn' AND "credential_id" IS NOT NULL AND "public_key" IS NOT NULL)
        OR ("type" = 'totp' AND "credential_id" IS NULL AND "public_key" IS NULL)
    );

-- Prisma cannot express a partial unique index, so it is declared here. Credential ids are
-- binary and case-sensitive; the index also rejects a second enrollment of the same
-- authenticator (duplicate credential).
CREATE UNIQUE INDEX "mfa_factors_credential_id_key"
    ON "mfa_factors" ("credential_id")
    WHERE "credential_id" IS NOT NULL;
