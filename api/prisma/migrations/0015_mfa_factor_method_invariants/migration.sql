-- A factor row must carry the material its method needs (card #38 review, finding 5).
--
-- Both columns are nullable because a row is either TOTP or WebAuthn. Without a constraint a
-- `type='totp'` row could exist with no secret (verification then answers 503 forever) or a
-- WebAuthn row with no credential. The checks keep the invariant in the database so no code
-- path, migration or manual fix can create an unsatisfiable factor.

ALTER TABLE "mfa_factors"
  ADD CONSTRAINT "mfa_factors_totp_secret_check"
  CHECK ("type" <> 'totp' OR "secret_encrypted" IS NOT NULL);

ALTER TABLE "mfa_factors"
  ADD CONSTRAINT "mfa_factors_webauthn_credential_check"
  CHECK (
    "type" <> 'webauthn'
    OR ("credential_id" IS NOT NULL AND "public_key" IS NOT NULL)
  );
