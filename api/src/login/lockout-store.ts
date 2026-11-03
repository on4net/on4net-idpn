import type { PrismaClient } from '../generated/prisma/client.js';
import { LOCK_DURATION_MS, MAX_FAILED_ATTEMPTS } from './lockout.js';

/**
 * Records one failed credential check in a single statement.
 *
 * The counter used to be computed in the route from a snapshot and written back, so a burst of
 * parallel guesses all read the same count and the account never reached the limit. Here the
 * database applies the same policy as `nextFailureState` against the current row: a lock in
 * progress is left untouched, an elapsed lock restarts the window at 1, otherwise the counter
 * increments and the fifth failure sets `locked_until`.
 */
export async function recordFailedCredential(
  prisma: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  const until = new Date(now.getTime() + LOCK_DURATION_MS);
  await prisma.$executeRaw`
    UPDATE "users" SET
      "failed_login_count" = CASE
        WHEN "locked_until" IS NOT NULL AND "locked_until" > ${now} THEN "failed_login_count"
        WHEN "locked_until" IS NOT NULL THEN 1
        ELSE "failed_login_count" + 1
      END,
      "locked_until" = CASE
        WHEN "locked_until" IS NOT NULL AND "locked_until" > ${now} THEN "locked_until"
        WHEN (CASE WHEN "locked_until" IS NOT NULL THEN 1 ELSE "failed_login_count" + 1 END)
             >= ${MAX_FAILED_ATTEMPTS} THEN ${until}
        ELSE NULL
      END
    WHERE "id" = ${userId}::uuid`;
}
