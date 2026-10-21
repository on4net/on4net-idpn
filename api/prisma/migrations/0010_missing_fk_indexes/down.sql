-- Down migration for 0010_missing_fk_indexes.

DROP INDEX IF EXISTS "client_memberships_invited_by_idx";
DROP INDEX IF EXISTS "client_memberships_login_context_id_idx";
DROP INDEX IF EXISTS "refresh_tokens_client_id_idx";
DROP INDEX IF EXISTS "authorization_codes_client_id_idx";
