import { z } from 'zod';

const NamespaceSchema = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, 'Invalid namespace');

export const MemoryTypeSchema = z.enum([
  'fact',
  'preference',
  'decision',
  'event',
  'relationship',
  'insight',
  'file',
  'task',
  'project',
  'user_profile',
  'conversation',
  'procedure',
  'secret_reference',
  'credential', // legacy import only; new writes are rejected by the engine
  'custom',
]);

export const MemoryStatusSchema = z.enum(['active', 'superseded', 'archived']);

export const MemoryProvenanceSchema = z
  .object({
    created_by: z.string().max(160).optional(),
    conversation_id: z.string().max(256).optional(),
    session_id: z.string().max(256).optional(),
    source_id: z.string().max(512).optional(),
    source_hash: z.string().max(128).optional(),
    chunk_index: z.number().int().nonnegative().optional(),
    heading: z.string().max(512).optional(),
    evidence: z.string().max(4000).optional(),
    valid_from: z.string().datetime().optional(),
    valid_to: z.string().datetime().optional(),
  })
  .passthrough();

export const MemoryMetadataSchema = z
  .object({
    confidence: z.number().min(0).max(1).default(0.8),
    source: z.string().max(512).optional(),
    timestamp: z.string().datetime().optional(),
    provenance: MemoryProvenanceSchema.optional(),
    tags: z.array(z.string().trim().min(1).max(96)).max(128).default([]),
    version: z.number().int().positive().default(1),
    status: MemoryStatusSchema.default('active'),
    expires_at: z.string().datetime().optional(),
    importance: z.number().min(0).max(10).default(5),
    related_ids: z.array(z.string().uuid()).max(256).default([]),
    entities: z.array(z.string().trim().min(1).max(256)).max(128).default([]),
    contradictions: z.array(z.string().trim().min(1).max(512)).max(128).default([]),
    supersedes_ids: z.array(z.string().uuid()).max(256).default([]),
    access_count: z.number().int().nonnegative().default(0),
    last_accessed_at: z.string().datetime().optional(),
    last_decay_at: z.string().datetime().optional(),
    redacted: z.boolean().default(false),
    secret_reference: z.string().max(1024).optional(),
    credential_for: z.string().max(160).optional(), // legacy compatibility only
    description: z.string().max(2000).optional(),
    embedding_provider: z.string().max(256).optional(),
    embedding_space: z.string().max(320).optional(),
    embedding_dimensions: z.number().int().positive().max(4096).optional(),
    embedding_generated_at: z.string().datetime().optional(),
    embedding_degraded: z.boolean().optional(),
    embedding_error: z.string().max(500).optional(),
    is_secret: z.boolean().default(false), // legacy compatibility only
  })
  .passthrough();

export const MemorySchema = z.object({
  id: z.string().uuid(),
  type: MemoryTypeSchema,
  content: z.string().min(1).max(64_000),
  namespace: NamespaceSchema,
  metadata: MemoryMetadataSchema,
  embedding: z.array(z.number().finite()).max(4096).optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type Memory = z.infer<typeof MemorySchema>;
export type MemoryType = z.infer<typeof MemoryTypeSchema>;
export type MemoryMetadata = z.infer<typeof MemoryMetadataSchema>;

export const RememberRequestSchema = z.object({
  content: z.string().trim().min(1).max(64_000),
  type: MemoryTypeSchema.optional(),
  namespace: NamespaceSchema.optional(),
  metadata: MemoryMetadataSchema.partial().optional(),
  idempotency_key: z.string().trim().min(8).max(200).optional(),
});

const RecallRequestBaseSchema = z.object({
  query: z.string().max(8000).optional(),
  namespace: NamespaceSchema.optional(),
  type: MemoryTypeSchema.optional(),
  min_confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string().trim().min(1).max(96)).max(64).optional(),
  created_after: z.string().datetime().optional(),
  created_before: z.string().datetime().optional(),
  include_low_quality: z.boolean().optional(),
  include_secrets: z.boolean().optional(), // deprecated; raw secrets are never returned
  include_archived: z.boolean().optional(),
});

export const RecallRequestSchema = RecallRequestBaseSchema.extend({
  limit: z.number().int().positive().max(500).optional(),
});

export const InternalRecallRequestSchema = RecallRequestBaseSchema.extend({
  limit: z.number().int().positive().max(5000).optional(),
});

export const EditRequestSchema = z.object({
  id: z.string().uuid(),
  content: z.string().trim().min(1).max(64_000).optional(),
  metadata: MemoryMetadataSchema.partial().optional(),
  namespace: NamespaceSchema.optional(),
  expected_version: z.number().int().positive().optional(),
});

export const ForgetRequestSchema = z.object({
  id: z.string().uuid(),
  namespace: NamespaceSchema.optional(),
  expected_version: z.number().int().positive().optional(),
  hard_delete: z.boolean().optional(),
});

export type RememberRequest = z.input<typeof RememberRequestSchema>;
export type NormalizedRememberRequest = z.output<typeof RememberRequestSchema>;
export type RecallRequest = z.input<typeof InternalRecallRequestSchema>;
export type NormalizedRecallRequest = z.output<typeof InternalRecallRequestSchema>;
export type EditRequest = z.input<typeof EditRequestSchema>;
export type ForgetRequest = z.input<typeof ForgetRequestSchema>;

export const MemorySnapshotSchema = z.object({
  format: z.literal('zenos-memory-snapshot-v1'),
  generated_at: z.string().datetime(),
  namespace: NamespaceSchema.nullable(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/i),
  memories: z.array(MemorySchema).max(100_000),
});

export type MemorySnapshot = z.infer<typeof MemorySnapshotSchema>;

export function normalizeNamespace(value?: string): string {
  return NamespaceSchema.parse(value || process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos');
}
