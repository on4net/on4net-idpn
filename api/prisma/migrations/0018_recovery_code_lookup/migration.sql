-- Card #79: O(1) recovery-code verification.
-- `code_lookup` is a server-keyed HMAC of the normalised code (`<keyId>$<digest>`) next to the
-- Argon2id `code_hash`. Existing rows keep NULL and use the bounded fallback until their next
-- rotation; PostgreSQL treats NULLs as distinct, so the unique index only constrains new rows.
ALTER TABLE "mfa_recovery_codes" ADD COLUMN "code_lookup" VARCHAR(100);

CREATE UNIQUE INDEX "mfa_recovery_codes_factor_id_code_lookup_key"
  ON "mfa_recovery_codes" ("factor_id", "code_lookup");
