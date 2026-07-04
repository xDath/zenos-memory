import { z } from 'zod';

export const MemoryTypeSchema = z.enum([
  'fact',
  'preference',
  'event',
  'relationship',
  'insight',
  'file',
  'task',
  'project',
  'user_profile',
  'conversation',
  'procedure',
  'credential',
  'custom'
]);

export const MemoryMetadataSchema = z.object({
  confidence: z.number().min(0).max(1).default(0.8),
  source: z.string().optional(),
  timestamp: z.string().datetime().optional(),
  provenance: z.object({
    created_by: z.string().optional(),
    conversation_id: z.string().optional(),
    session_id: z.string().optional(),
  }).optional(),
  tags: z.array(z.string()).default([]),
  version: z.number().int().positive().default(1),
  expires_at: z.string().datetime().optional(),
  importance: z.number().min(0).max(10).default(5),
  related_ids: z.array(z.string()).default([]),
  // Tier-up fields
  entities: z.array(z.string()).default([]),
  contradictions: z.array(z.string()).default([]),
  supersedes_ids: z.array(z.string()).default([]),
  access_count: z.number().int().nonnegative().default(0),
  last_accessed_at: z.string().datetime().optional(),
  // Credential specific
  is_secret: z.boolean().default(false),
  credential_for: z.string().optional(), // e.g. "vercel", "openai", "github"
  redacted: z.boolean().default(false), // whether the content is redacted in some views
});

export const MemorySchema = z.object({
  id: z.string().uuid(),
  type: MemoryTypeSchema,
  content: z.string().min(1),
  namespace: z.string().default('default'),
  metadata: MemoryMetadataSchema,
  embedding: z.array(z.number()).optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type Memory = z.infer<typeof MemorySchema>;
export type MemoryType = z.infer<typeof MemoryTypeSchema>;
export type MemoryMetadata = z.infer<typeof MemoryMetadataSchema>;

export const RememberRequestSchema = z.object({
  content: z.string().min(1),
  type: MemoryTypeSchema.optional().default('fact'),
  namespace: z.string().optional().default('default'),
  metadata: MemoryMetadataSchema.partial().optional(),
});

export const RecallRequestSchema = z.object({
  query: z.string().default(''),
  namespace: z.string().optional().default('default'),
  type: MemoryTypeSchema.optional(),
  limit: z.number().int().positive().max(50).default(10),
  min_confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  created_after: z.string().datetime().optional(),
  created_before: z.string().datetime().optional(),
  include_low_quality: z.boolean().optional().default(false),
  include_secrets: z.boolean().optional().default(false), // special flag for credential queries
});

export const EditRequestSchema = z.object({
  id: z.string().uuid(),
  content: z.string().min(1).optional(),
  metadata: MemoryMetadataSchema.partial().optional(),
  namespace: z.string().optional(),
});

export const ForgetRequestSchema = z.object({
  id: z.string().uuid(),
  namespace: z.string().optional(),
});

export type RememberRequest = z.infer<typeof RememberRequestSchema>;
export type RecallRequest = z.infer<typeof RecallRequestSchema>;
