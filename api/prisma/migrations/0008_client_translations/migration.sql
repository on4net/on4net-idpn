-- Per-client interface message overrides (docs/domain-model.md 2.6.4,
-- docs/localization.md 4 and 7). Keys are validated against the shared base bundle before
-- they reach this table; an empty value is deleted instead of stored.
--
-- Locale settings (default, supported, calendar and the cache version) stay in
-- `clients.locales`; this table only stores the changed message values.

-- CreateTable
CREATE TABLE "client_translations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" UUID NOT NULL,
    "locale" VARCHAR(35) NOT NULL,
    "key" VARCHAR(160) NOT NULL,
    "value" VARCHAR(500) NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_translations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_translations_client_id_locale_key_key"
    ON "client_translations"("client_id", "locale", "key");

-- CreateIndex
CREATE INDEX "client_translations_client_id_locale_idx"
    ON "client_translations"("client_id", "locale");

-- AddForeignKey
ALTER TABLE "client_translations"
    ADD CONSTRAINT "client_translations_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
