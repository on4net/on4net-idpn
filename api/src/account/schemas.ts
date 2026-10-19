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

/** MFA enrollment and management bodies (docs/account-api.md). */
export const enrollTotpSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export const verifyTotpEnrollmentSchema = z
  .object({
    factorId: z.string().uuid(),
    code: z.string().trim().min(6).max(8),
  })
  .strict();

export const disableTotpSchema = z
  .object({
    factorId: z.string().uuid().optional(),
    password: z.string().min(1).max(128).optional(),
    code: z.string().trim().min(6).max(12).optional(),
  })
  .strict()
  .refine(
    (value) => value.password !== undefined || value.code !== undefined,
    'password or code is required',
  );

export const regenerateRecoveryCodesSchema = z
  .object({
    password: z.string().min(1).max(128),
  })
  .strict();

/**
 * WebAuthn ceremony bodies. The browser response is validated only structurally: the
 * cryptographic meaning is checked by the server verifier. Strings are bounded so a hostile
 * body cannot allocate unbounded memory.
 */
export const webauthnResponseSchema = z.object({
  id: z.string().min(1).max(2048),
  rawId: z.string().min(1).max(2048),
  type: z.literal('public-key'),
  response: z.record(z.string(), z.unknown()),
  clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
  authenticatorAttachment: z.string().max(32).optional(),
});

export const verifyWebauthnRegistrationSchema = z.object({
  challengeId: z.string().min(20).max(128),
  response: webauthnResponseSchema,
  name: z.string().trim().min(1).max(64).optional(),
});

export const verifyWebauthnAuthenticationSchema = z.object({
  challengeId: z.string().min(20).max(128),
  response: webauthnResponseSchema,
});

export const loginWebauthnOptionsSchema = z.object({
  challengeToken: z.string().min(20).max(128),
});

export const loginWebauthnVerifySchema = z.object({
  challengeToken: z.string().min(20).max(128),
  challengeId: z.string().min(20).max(128),
  response: webauthnResponseSchema,
});

export const renameMfaFactorSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
  })
  .strict();

/** Account lifecycle bodies (docs/auth-flows.md 8.2-8.4). The token is opaque and single-use. */
export const forgotPasswordSchema = z
  .object({
    email: z.string().trim().min(3).max(320).email(),
  })
  .strict();

export const accountTokenSchema = z
  .object({
    token: z.string().trim().min(16).max(512),
  })
  .strict();

export const setPasswordWithTokenSchema = z
  .object({
    token: z.string().trim().min(16).max(512),
    password: z.string().min(1).max(256),
  })
  .strict();

export const requestVerificationSchema = forgotPasswordSchema;

export type EnrollTotpBody = z.infer<typeof enrollTotpSchema>;
export type VerifyTotpEnrollmentBody = z.infer<typeof verifyTotpEnrollmentSchema>;
export type DisableTotpBody = z.infer<typeof disableTotpSchema>;
export type RegenerateRecoveryCodesBody = z.infer<typeof regenerateRecoveryCodesSchema>;
