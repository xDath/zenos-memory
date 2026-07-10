import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { buildMutationPlan } from '../../../lib/memory-mutation';

const MutationPlanSchema = z.object({
  content: z.string().trim().min(1).max(64_000),
  namespace: z.string().trim().min(1).max(96).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/).optional().default('zenos'),
  limit: z.number().int().min(1).max(500).optional().default(200),
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const parsed = MutationPlanSchema.parse(await request.json());
    const memories = await getMemoryEngine().list(parsed.namespace, parsed.limit);
    const plan = buildMutationPlan(parsed.content, memories);
    return jsonResponse({
      success: true,
      namespace: parsed.namespace,
      mode: 'state-aware-mutation-plan',
      plan,
      candidates_checked: memories.length,
      superseded_candidates: memories.filter(memory => plan.supersedes_ids.includes(memory.id)),
      related_candidates: memories.filter(memory => plan.related_ids.includes(memory.id)),
      request_id: id,
    }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
