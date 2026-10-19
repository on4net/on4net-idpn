import { z } from 'zod';

/** Length limits mirror docs/security.md 3.1; complexity rules live in password-policy. */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(1).max(128),
  })
  .strict();

export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;

export const accountSessionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
