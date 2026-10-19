DROP INDEX IF EXISTS "mfa_factors_credential_id_key";

ALTER TABLE "mfa_factors" DROP CONSTRAINT IF EXISTS "mfa_factors_webauthn_fields_check";

ALTER TABLE "mfa_factors"
    DROP COLUMN IF EXISTS "backed_up",
    DROP COLUMN IF EXISTS "device_type",
    DROP COLUMN IF EXISTS "aaguid",
    DROP COLUMN IF EXISTS "transports";
