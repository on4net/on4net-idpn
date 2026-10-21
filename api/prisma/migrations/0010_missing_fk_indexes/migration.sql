-- Supporting indexes for foreign keys that had none (docs/domain-model.md; performance review of
-- the initial schema). Every other FK is covered by the leftmost column of an index; these four
-- appear only in `ALTER TABLE … ADD CONSTRAINT`, so a cascade or a per-client token query would
-- scan the highest-write tables.

-- CreateIndex
CREATE INDEX "authorization_codes_client_id_idx" ON "authorization_codes"("client_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_client_id_idx" ON "refresh_tokens"("client_id");

-- CreateIndex
CREATE INDEX "client_memberships_login_context_id_idx" ON "client_memberships"("login_context_id");

-- CreateIndex
CREATE INDEX "client_memberships_invited_by_idx" ON "client_memberships"("invited_by");
