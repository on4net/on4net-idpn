ALTER TABLE "account_tokens" DROP CONSTRAINT IF EXISTS "account_tokens_user_id_fkey";

ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
