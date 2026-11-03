-- At most one signing key may be `active` (docs/security.md 9, finding 1 of #75).
--
-- Two concurrent rotations could both write an `active` row, which makes JWKS ambiguous and
-- the "newest active key signs" rule non-deterministic. A partial unique index enforces the
-- invariant in the database, so the second transaction fails instead of diverging.
--
-- Existing databases may already hold duplicates from before this migration; the older rows
-- are retired first (newest wins, matching what the key manager would have picked).

UPDATE "signing_keys"
   SET "status" = 'retired',
       "retired_at" = CURRENT_TIMESTAMP
 WHERE "status" = 'active'
   AND "kid" NOT IN (
     SELECT "kid" FROM (
       SELECT "kid"
         FROM "signing_keys"
        WHERE "status" = 'active'
        ORDER BY "created_at" DESC, "kid" DESC
        LIMIT 1
     ) AS newest
   );

CREATE UNIQUE INDEX "signing_keys_single_active_idx"
  ON "signing_keys" ("status")
  WHERE "status" = 'active';
