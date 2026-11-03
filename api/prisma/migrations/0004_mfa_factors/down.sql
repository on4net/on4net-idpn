DROP INDEX IF EXISTS "mfa_factors_one_totp_per_user";

ALTER TABLE "mfa_recovery_codes" DROP CONSTRAINT IF EXISTS "mfa_recovery_codes_factor_id_fkey";
ALTER TABLE "mfa_factors" DROP CONSTRAINT IF EXISTS "mfa_factors_user_id_fkey";

DROP TABLE IF EXISTS "mfa_recovery_codes";
DROP TABLE IF EXISTS "mfa_factors";

DROP TYPE IF EXISTS "MfaFactorType";
