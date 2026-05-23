import { z } from 'zod';

export const CreateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(100),
});
export type CreateWorkspaceDto = z.infer<typeof CreateWorkspaceSchema>;

export const UpdateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
});
export type UpdateWorkspaceDto = z.infer<typeof UpdateWorkspaceSchema>;
