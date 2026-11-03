ALTER TABLE "mfa_factors" DROP CONSTRAINT IF EXISTS "mfa_factors_totp_secret_check";
ALTER TABLE "mfa_factors" DROP CONSTRAINT IF EXISTS "mfa_factors_webauthn_credential_check";
