import { z } from 'zod';

export const RecallFeedbackRequestSchema = z.object({
  feedback_id: z.string().trim().min(8).max(220),
  namespace: z.string().trim().min(1).max(96).optional().default('zenos'),
  outcome: z.enum(['helpful', 'not_helpful', 'unused']),
  memory_ids: z.array(z.string().trim().min(1).max(220)).min(1).max(60)
    .transform(values => [...new Set(values)]),
  run_id: z.string().trim().min(1).max(220).optional(),
  session_id: z.string().trim().min(1).max(256).optional(),
  source: z.string().trim().min(1).max(220).optional().default('runtime-outcome'),
});

export type RecallFeedbackRequest = z.infer<typeof RecallFeedbackRequestSchema>;

export type RecallFeedbackResult = {
  feedback_id: string;
  namespace: string;
  outcome: RecallFeedbackRequest['outcome'];
  requested: number;
  updated: number;
  missing: string[];
  deduplicated: boolean;
  updated_at: string;
};
