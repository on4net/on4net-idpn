import { z } from 'zod';

export const memberStatusSchema = z.enum(['invited', 'active', 'suspended']);

export const listMembersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: memberStatusSchema.optional(),
  q: z.string().trim().min(1).max(120).optional(),
});

export const inviteMemberSchema = z.object({
  email: z.string().trim().email().max(320),
  displayName: z.string().trim().min(1).max(120).optional(),
  roleKeys: z.array(z.string().trim().min(1).max(160)).max(50).default([]),
  attributes: z.record(z.string(), z.unknown()).default({}),
});

export const updateMemberSchema = z
  .object({
    status: memberStatusSchema.optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });

export const replaceMemberRolesSchema = z.object({
  roleKeys: z.array(z.string().trim().min(1).max(160)).max(50),
});

export type InviteMemberBody = z.infer<typeof inviteMemberSchema>;
export type UpdateMemberBody = z.infer<typeof updateMemberSchema>;
