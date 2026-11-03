-- Account lifecycle tokens are derived from the user: a hard delete must not be blocked by a
-- leftover invite/verification/reset row (docs/domain-model.md 4). Retention of consumed and
-- long-expired rows is enforced by the scheduled purge in the API.
ALTER TABLE "account_tokens" DROP CONSTRAINT IF EXISTS "account_tokens_user_id_fkey";

ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
