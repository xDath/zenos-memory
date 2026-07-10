import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, NotFoundError, requestId } from '../../../lib/errors';
import { jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';

const LinkSchema = z.object({
  id1: z.string().uuid(),
  id2: z.string().uuid(),
  relation: z.string().trim().min(1).max(96).optional().default('related'),
  namespace: z.string().optional(),
}).refine(value => value.id1 !== value.id2, { message: 'A memory cannot be linked to itself' });

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const parsed = LinkSchema.parse(await request.json());
    const linked = await getMemoryEngine().linkMemories(parsed.id1, parsed.id2, parsed.relation, parsed.namespace);
    if (!linked) throw new NotFoundError('One or both memories were not found in the same namespace');
    return jsonResponse({ success: true, linked: true, request_id: id }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  }
}
