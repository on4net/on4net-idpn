DROP INDEX IF EXISTS "mfa_recovery_codes_factor_id_code_lookup_key";
ALTER TABLE "mfa_recovery_codes" DROP COLUMN IF EXISTS "code_lookup";
