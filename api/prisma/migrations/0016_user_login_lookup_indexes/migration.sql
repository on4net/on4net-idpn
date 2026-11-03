-- The login lookup filters `email`/`username` without a tenant, so neither
-- `(tenant_id, email)` nor `(tenant_id, username)` can serve it: PostgreSQL degrades to a
-- sequential scan of `users` before every Argon2id verification (card #18 finding 3).
--
-- Identifiers are stored lower-cased by the API, so plain column indexes match the equality
-- predicates; the partial predicate keeps deleted rows out of the index.

CREATE INDEX "users_email_lookup_idx" ON "users" ("email") WHERE "deleted_at" IS NULL;
CREATE INDEX "users_username_lookup_idx" ON "users" ("username") WHERE "deleted_at" IS NULL;
