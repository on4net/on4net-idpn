ALTER TABLE "account_tokens" DROP CONSTRAINT IF EXISTS "account_tokens_user_id_fkey";

DROP TABLE IF EXISTS "account_tokens";

DROP TYPE IF EXISTS "AccountTokenPurpose";
