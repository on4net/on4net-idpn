-- First-run install wizard. A single row means "this instance is installed"; the wizard routes
-- are mounted only while the table is empty. `installed` is a constant-true primary key, so the
-- database itself guarantees at most one install and two concurrent completions cannot both win.
CREATE TABLE "system_install" (
    "installed" BOOLEAN NOT NULL DEFAULT true,
    "installed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "installed_by" UUID,
    "source" VARCHAR(16) NOT NULL,
    CONSTRAINT "system_install_pkey" PRIMARY KEY ("installed"),
    CONSTRAINT "system_install_installed_true" CHECK ("installed"),
    CONSTRAINT "system_install_source_check" CHECK ("source" IN ('wizard', 'existing'))
);

-- An instance that already has a user with a credential was installed by hand (seed + scripts):
-- mark it so the wizard never opens on an upgraded, running deployment.
INSERT INTO "system_install" ("source")
SELECT 'existing'
WHERE EXISTS (
    SELECT 1 FROM "users" WHERE "password_hash" IS NOT NULL AND "deleted_at" IS NULL
);
